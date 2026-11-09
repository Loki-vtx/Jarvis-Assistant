// @ts-check

/** @type {import('./src/context').Config} */
export default {
    admin: {
        users: ['918437723755384832'],
    },
    ai: {
        dm: false,
        guilds: {
            '1416053994853236890': { roles: ['1429091115163848795'], users: ['918437723755384832'] },
        },
    },
    mod: {
        mute: {
            reapplyTimeoutInterval: 86400,
        },
        guilds: {
            '1416053994853236890': {
                roles: ['1429091115163848795'],
            },
        },
    },
    notes: {},
    prefix: {
        matches: ['J', 'j!'],
        mentions: true,
    },
}