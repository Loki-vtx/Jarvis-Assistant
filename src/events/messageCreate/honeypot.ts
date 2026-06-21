import assert from 'assert'
import { bot, config, log } from '~/context'
import { s, string } from '~/strings'
import { embed, field } from '~/utils/embeds'
import { getGuild, getMember, isMemberManageable } from '~/utils/guilds'
import { sendModerationLog } from '~/utils/mod'

const EventName = 'messageCreate'
const EventHandlerName = 'honeypot'
const LogTag = `events/${EventName}/${EventHandlerName}`

bot.on(EventName, async msg => {
    if (msg.author.bot) return

    const guildId = msg.guildID
    if (!guildId) return

    const guildConfig = config.mod?.honeypot?.[guildId]
    if (!guildConfig) return

    const guild = await getGuild(guildId)
    assert(guild, 'Guild not available')

    const member = await getMember(guildId, msg.author.id)
    assert(member, 'Member not available')

    const channelId = msg.channelID
    if (!guildConfig.channels.includes(channelId)) return

    if (!(await isMemberManageable(member)))
        return log.warn(
            LogTag,
            `Honeypot triggered by unmanageable member ${msg.author.tag} (${msg.author.id}) in channel ${channelId} of guild ${guildId}, but they couldn't be banned.`,
        )

    log.info(
        LogTag,
        `Honeypot triggered by ${msg.author.tag} (${msg.author.id}) in channel ${channelId} of guild ${guildId}`,
    )

    const auditReason = string(s.command.ban.reason.honeypot, channelId)

    await guild.createBan(msg.author.id, {
        reason: auditReason,
        // Purge last minute of messages from the user if they've sent the spam message in other channels
        deleteMessageSeconds: 60,
    })

    await guild.removeBan(msg.author.id, auditReason)

    await sendModerationLog(
        embed({
            title: string(s.command.ban.action, msg.author.tag),
            description: string(s.command.ban.description.honeypot),
            fields: [
                field(string(s.generic.member), msg.author.mention),
                field(string(s.generic.channel), `<#${channelId}>`, true),
            ],
        }),
        guildId,
    )
})
