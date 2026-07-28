import assert from 'assert'
import { GenkitError } from 'genkit'
import { Base, type Message } from 'oceanic.js'
import { inspect } from 'util'
import { ai, config, log } from '~/context'
import { getChannel, isTextableChannel } from '../channels'
import { getMember } from '../guilds'
import { getUser } from '../users'
import {
    BaseSystemPrompt,
    DiscordMessageIdToLLMMessageId,
    Histories,
    HistoryMinimumThreshold,
    MaxHistoryEntryExpiry,
    MaxHistoryGroupLength,
    MaxOutputTokens,
    Models,
    Temparature,
    Timeout,
    TopKeywords,
    TopPercent,
    WithMediaTimeout,
} from './constants'
import {
    addHistoryEntry,
    buildModelMessages,
    CurrentMessageId,
    formatMessage,
    formatMessageGroup,
    formatTime,
    getResponseContent,
    hasMedia,
    inlineMediaMessages,
    inlineMediaParts,
} from './utils'

const LogTag = 'utils/ai'

export async function isAIAllowed(msg: Message): Promise<boolean> {
    if (!msg.guildID) return Boolean(config.ai?.dm)

    const guildConfig = config.ai?.guilds[msg.guildID]
    if (!guildConfig) return false

    if (guildConfig === true) return true
    if (guildConfig.users?.includes(msg.author.id)) return true
    if (guildConfig.roles?.length) {
        const member = msg.member ?? (await getMember(msg.guildID, msg.author.id))
        if (member?.roles.some(role => guildConfig.roles!.includes(role))) return true
    }

    return false
}

export async function respondFromMessage(msg: Message) {
    const channel = await getChannel(msg.channelID)
    assert(channel && isTextableChannel(channel), 'Channel not available or is not textable')

    // biome-ignore lint/suspicious/noAssignInExpressions: This is readable
    const history = (Histories[msg.channelID] ??= [])

    if (history.length < HistoryMinimumThreshold) {
        try {
            const recentMessages = await channel.getMessages({
                limit: 50,
                before: msg.id,
                after: Base.generateID(Date.now() - MaxHistoryEntryExpiry),
            })

            // Group messages by author
            const groups: Message[][] = []
            let currentGroup: Message[] = []

            for (const m of recentMessages.reverse()) {
                if (m.author.bot) continue

                if (currentGroup[0]?.author.id === m.author.id) {
                    currentGroup.push(m)
                } else {
                    if (currentGroup.length > 0) groups.push(currentGroup)
                    currentGroup = [m]
                }
            }
            if (currentGroup.length > 0) groups.push(currentGroup)

            const lastGroups = groups.slice(-MaxHistoryGroupLength)

            for (const group of lastGroups) {
                const groupContent = await formatMessageGroup(group, channel, history, 0)
                addHistoryEntry(history, {
                    role: 'user',
                    content: groupContent,
                    metadata: { created: group.at(-1)?.createdAt.getTime(), messageIds: group.map(m => m.id) },
                })
            }
        } catch (err) {
            log.warn(LogTag, 'Failed to fetch recent messages for context:', err)
        }
    }

    const content = await formatMessage(msg, channel, history)
    const metadata = {
        created: Date.now(),
        messageIds: [msg.id],
    }

    addHistoryEntry(history, {
        role: 'user',
        content,
        metadata,
    })

    const Bosses = await Promise.all(config.admin.users.map(getUser))
    const InfoSection = `

### Info

  * **Bosses**:
${Bosses.filter(Boolean)
    .map(b => `    - ${b!.globalName} (@${b!.tag})`)
    .join('\n')}
  * **Server**: ${'guildID' in channel ? channel.guildID : '(None)'}
  * **Channel**: ${'name' in channel ? channel.name : '(DM)'}
  * **Current Time**: ${formatTime(new Date(), 'full')} (Pacific Time)`

    // Only the directly referenced message keeps attachments
    const directRefId = msg.messageReference?.messageID
    // System prompt, global history, channel history, and user query are sent as separate blocks.
    // The query is passed via `prompt` instead.
    const messages = buildModelMessages(history, [msg.id], directRefId ? [directRefId] : [])

    // Attachment URLs are stored, but Gemini API can't resolve them, so they are reuploaded before sending.
    const [promptContent, promptMessages] = await Promise.all([
        inlineMediaParts(content),
        inlineMediaMessages(messages),
    ])

    const withMedia = hasMedia(promptContent, ...promptMessages.map(m => m.content))

    log.debug(
        LogTag,
        `Generating AI response for message ${msg.id} with content:`,
        inspect([...messages, content], { depth: 5 }),
    )

    await channel.sendTyping()
    // Random delay
    await new Promise(resolve => setTimeout(resolve, Math.random() * 1000 + 500))

    // Try each model in order, if one fails, log the error and try the next one
    for (const model of Models) {
        log.debug(LogTag, `Attempting to generate AI response for message ${msg.id} with model ${model.name}`)

        try {
            const response = await ai.generate({
                model,
                system: BaseSystemPrompt + InfoSection,
                abortSignal: AbortSignal.timeout(withMedia ? WithMediaTimeout : Timeout),
                config: {
                    temperature: Temparature,
                    topK: TopKeywords,
                    topP: TopPercent,
                    maxOutputTokens: MaxOutputTokens + 50, // +50 for message formatting
                    googleSearch: {},
                    urlContext: {},
                },
                messages: promptMessages,
                prompt: promptContent,
            })

            if (!response.message) throw new Error('No response generated')

            const responseText = response.text

            log.debug(LogTag, `AI response generated for message ${msg.id}:`, responseText)

            const contentText = getResponseContent(response.text)
            const res = await channel.createMessage({
                content: contentText,
                messageReference: {
                    failIfNotExists: true,
                    messageID: msg.id,
                },
            })

            // Set before formatting message as formatMessage does CurrentMessageId++
            // and we want to use the same ID for the response message
            DiscordMessageIdToLLMMessageId.set(res.id, CurrentMessageId)

            addHistoryEntry(
                history,
                {
                    role: 'model',
                    content: await formatMessage(res, channel, history, 0),
                    metadata: { created: Date.now(), messageIds: [res.id] },
                },
                true,
            )

            // Success!
            return
        } catch (err) {
            if (err instanceof GenkitError && err.code === 429) {
                log.warn(LogTag, `Model ${model.name} rate limited, trying next model...`)
                continue
            }
            log.error(LogTag, `Error generating AI response for message ${msg.id} with model ${model.name}:`, err)
        }
    }
}
