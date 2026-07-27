import { bot } from '~/context'
import { removeMessageFromHistories } from '~/utils/ai/utils'

bot.on('messageDelete', msg => {
    removeMessageFromHistories(msg.id, msg.channelID)
})

bot.on('messageDeleteBulk', msgs => {
    for (const msg of msgs) removeMessageFromHistories(msg.id, msg.channelID)
})
