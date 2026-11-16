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
            '1566224704082022544': { roles: ['1567715528653537300'] },
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
            '1566224704082022544': {
                roles: ['1566252869068394627'],
            },
        },
    },
    notes: {},
    prefix: {
        matches: ['J', 'j!'],
        mentions: true,
    },
}