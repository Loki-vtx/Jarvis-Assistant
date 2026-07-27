import { config } from '~/context'
import { getChannel } from '../channels'
import { moderatorOnlyPreciate } from '../commands'
import { getGuild } from '../guilds'
import { getMessage } from '../messages'
import { replaceAllAsync } from '../strings'
import { getUser } from '../users'
import {
    DiscordMessageIdToLLMMessageId,
    GlobalHistory,
    Histories,
    HistoryEntrySeparator,
    HistoryReset,
    MaxGlobalHistoryLength,
    MaxHistoryEntryExpiry,
    MaxHistoryLength,
    MaxLinkFollow,
    TagAdmin,
    TagModel,
    TagModerator,
    TimeZone,
} from './constants'
import type { Part } from 'genkit'
import type { Message } from 'oceanic.js'
import type { ChatCommandExecuteContext } from '~/classes/commands/ChatCommand'
import type { TextableChannel } from '../channels'
import type { MessageData, MessageDataEntry } from './types'

export let CurrentMessageId = 0

const MimeMap = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
} as const

const UserMentionRegex = /<@!?(\d+)>/g
const ChannelMentionRegex = /<#(\d+)>/g
const RoleMentionRegex = /<@&(\d+)>/g
const EmojiRegex = /<a?:([\w~]+):\d+>/g

export function formatTime(date: Date, style: 'short' | 'full' = 'short') {
    return date.toLocaleString(
        'en-US',
        style === 'full'
            ? { timeZone: TimeZone, dateStyle: 'full', timeStyle: 'short' }
            : {
                  timeZone: TimeZone,
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
              },
    )
}

export async function resolveMentions(content: string, guildID?: string | null): Promise<string> {
    // Emojis: <:NAME:ID> and <a:NAME:ID> -> :NAME:
    content = content.replace(EmojiRegex, (_, name) => `:${name}:`)

    content = await replaceAllAsync(content, UserMentionRegex, async ([full, id]) => {
        const user = await getUser(id!)
        return user ? `@${user.globalName ?? user.username}` : full!
    })

    content = await replaceAllAsync(content, ChannelMentionRegex, async ([full, id]) => {
        const channel = await getChannel(id!)
        return channel && 'name' in channel && channel.name ? `#${channel.name}` : full!
    })

    if (guildID) {
        const guild = await getGuild(guildID)
        if (guild)
            content = content.replace(RoleMentionRegex, (full, id) => {
                const role = guild.roles.get(id)
                return role ? `@${role.name}` : full
            })
    }

    return content
}

export async function formatMessage(
    msg: Message,
    channel: TextableChannel,
    history: MessageData,
    recurse = MaxLinkFollow,
): Promise<Part[]> {
    return formatMessageGroup([msg], channel, history, recurse)
}

export async function formatMessageGroup(
    msgs: Message[],
    channel: TextableChannel,
    history: MessageData,
    recurse = MaxLinkFollow,
): Promise<Part[]> {
    if (CurrentMessageId > HistoryReset) CurrentMessageId = 0
    if (!msgs.length) return []

    const firstMsg = msgs[0]!
    const { author: user } = firstMsg
    const { globalName: ugname, username: uname, id: uid } = user

    const msgChannel =
        firstMsg.channelID === channel.id ? channel : ((await getChannel(firstMsg.channelID)) as TextableChannel | null)

    // REST-fetched messages don't have guild_id, fall back to the channel's guild
    const guildID = firstMsg.guildID ?? (msgChannel && 'guildID' in msgChannel ? msgChannel.guildID : null)

    const roles: string[] = []

    if (uid === firstMsg.client.user.id) roles.push(TagModel)
    if (config.admin.users.includes(uid)) roles.push(TagAdmin)
    if (guildID && (await moderatorOnlyPreciate({ executor: user, trigger: { guildID } } as ChatCommandExecuteContext)))
        roles.push(TagModerator)

    const isBossOrMod = roles.includes(TagAdmin) || roles.includes(TagModerator)
    const id = CurrentMessageId++

    let attrs = `id=${id} user="${sanitizeAttr(ugname ?? uname)}"`
    if (roles.length) attrs += ` role="${roles.join(',')}"`
    attrs += ` time="${formatTime(firstMsg.createdAt)}"`

    // Location info (guild + channel, name and ID)
    const guild = guildID ? await getGuild(guildID) : null
    attrs += guild ? ` server="${sanitizeAttr(guild.name)} (${guild.id})"` : ' server="DM"'

    attrs +=
        msgChannel && 'name' in msgChannel && msgChannel.name
            ? ` channel="#${sanitizeAttr(msgChannel.name)} (${firstMsg.channelID})"`
            : ` channel="DM (${firstMsg.channelID})"`

    // Reference from any message in the group
    // But we only handle the first one that has a reference for simplicity
    const msgWithRef = msgs.find(m => m.messageReference)
    if (msgWithRef && recurse > 0) {
        const mid = msgWithRef.messageReference!.messageID!
        let rId: number | undefined = DiscordMessageIdToLLMMessageId.get(mid)

        if (rId === undefined) {
            const rMsg = await getMessage(channel, mid)
            if (rMsg) {
                // Set before formatting message as we do CurrentMessageId++
                // and we want to use the same ID for the response message
                DiscordMessageIdToLLMMessageId.set(mid, CurrentMessageId)
                addHistoryEntry(history, {
                    role: rMsg.author.id === firstMsg.client.user.id ? 'model' : 'user',
                    content: await formatMessageGroup([rMsg], channel, history, recurse - 1),
                    metadata: { created: rMsg.createdAt.getTime(), messageIds: [rMsg.id] },
                })
            }
            rId = DiscordMessageIdToLLMMessageId.get(mid)
        }

        if (rId !== undefined) attrs += ` reply=${rId}`
    }

    for (const m of msgs) {
        DiscordMessageIdToLLMMessageId.set(m.id, id)
    }

    const contents: string[] = []
    const parts: Part[] = []

    for (const msg of msgs) {
        // Resolve mentions first, then sanitize (escaping first would break the mention markup)
        let content = sanitizeMessage(await resolveMentions(msg.content, guildID))

        if (!isBossOrMod && content.length > 1000) {
            content = `${content.slice(0, 1000)}... (trimmed)`
        }
        contents.push(content)

        // Image recognition from attachments
        for (const attachment of msg.attachments.values()) {
            if (attachment.contentType?.startsWith('image/')) {
                parts.push({
                    media: {
                        url: attachment.url,
                        contentType: attachment.contentType,
                    },
                })
            }
        }

        // Embedded images
        for (const embed of msg.embeds) {
            if (embed.type !== 'image') continue
            if (!embed.thumbnail?.url) continue

            const url = embed.thumbnail.url
            const ext = url.split('.').pop()?.toLowerCase()
            const contentType = ext && MimeMap[ext as keyof typeof MimeMap]
            if (!contentType) continue

            parts.push({
                media: {
                    url: embed.thumbnail.url,
                    contentType,
                },
            })
        }
    }

    parts.unshift({
        text: `<msg ${attrs}>${contents.join('\n')}</msg>`,
    })

    return parts
}

export function getResponseContent(text: string): string {
    const content = text.replace(/<\/?msg[^>]*>/g, '').trim()
    if (!content) throw new Error('Empty response from model')
    return content
}

function entryMessageIds(entry: MessageDataEntry): string[] {
    const ids = entry.metadata?.messageIds
    return Array.isArray(ids) ? (ids as string[]) : []
}

function isSameEntry(a: MessageDataEntry, b: MessageDataEntry): boolean {
    // Compare by Discord message IDs when available
    const aIds = entryMessageIds(a)
    const bIds = entryMessageIds(b)
    if (aIds.length && bIds.length) return aIds.some(id => bIds.includes(id))

    // Fall back to content comparison
    return (
        a.role === b.role &&
        a.content.length === b.content.length &&
        a.content.every((p, i) => p.text === b.content[i]?.text && p.media?.url === b.content[i]?.media?.url)
    )
}

export function addHistoryEntry(history: MessageData, data: MessageDataEntry, trim?: boolean) {
    if (!history.some(e => isSameEntry(e, data))) history.push(data)
    if (!GlobalHistory.some(e => isSameEntry(e, data))) GlobalHistory.push(data)

    if (trim) {
        trimHistory(GlobalHistory, MaxGlobalHistoryLength)
        trimHistory(history, MaxHistoryLength)
    }
}

export function removeMessageFromHistories(messageId: string, channelId?: string) {
    DiscordMessageIdToLLMMessageId.delete(messageId)

    const prune = (history: MessageData) => {
        for (let i = history.length - 1; i >= 0; i--) {
            if (entryMessageIds(history[i]!).includes(messageId)) history.splice(i, 1)
        }
    }

    prune(GlobalHistory)

    if (channelId) {
        const history = Histories[channelId]
        if (history) prune(history)
    } else for (const history of Object.values(Histories)) prune(history)
}

/**
 * Builds the message list for the model:
 * 1. Global history deduped against the channel history
 * 2. Recent messages of the current channel.
 *
 * Entries in `excludeMessageIds` (the current user query, sent separately via `prompt`) are left out.
 *
 * Attachments are stripped from history entries except those in `keepMediaMessageIds` (the directly referenced message).
 * User query keeps its media as it is sent via `prompt`.
 */
export function buildModelMessages(
    history: MessageData,
    excludeMessageIds: string[] = [],
    keepMediaMessageIds: string[] = [],
) {
    const byCreated = (a: MessageDataEntry, b: MessageDataEntry) =>
        (Number(a.metadata?.created) || 0) - (Number(b.metadata?.created) || 0)

    const isExcluded = (e: MessageDataEntry) => entryMessageIds(e).some(id => excludeMessageIds.includes(id))

    // Recent messages in the current channel
    const channelMessages = history.filter(e => !isExcluded(e)).sort(byCreated)

    // Global history, deduped against the channel messages
    const globalMessages = GlobalHistory.filter(
        e => !isExcluded(e) && !channelMessages.some(m => isSameEntry(m, e)),
    ).sort(byCreated)

    const messages = [...globalMessages, ...channelMessages].slice(-HistoryReset)

    // First content should be user message
    while (messages.length && messages[0]!.role !== 'user') messages.shift()

    return messages.map(e => {
        if (!e.content.some(p => p.media)) return e
        if (entryMessageIds(e).some(id => keepMediaMessageIds.includes(id))) return e
        return { ...e, content: e.content.filter(p => !p.media) }
    })
}

export function trimHistory(history: MessageData, maxLength: number) {
    const dateThreshold = Date.now() - MaxHistoryEntryExpiry
    while (history[0] && (Number(history[0].metadata?.created) || 0) < dateThreshold) {
        history.shift()
    }

    if (history.length > maxLength) history.splice(0, history.length - maxLength)
}

function sanitizeMessage(content: string) {
    return content.replaceAll(HistoryEntrySeparator, '. ').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function sanitizeAttr(value: string) {
    return value.replaceAll('"', '').replaceAll('<', '').replaceAll('>', '')
}
