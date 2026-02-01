const { Mutex } = require('async-mutex');

// Locks
const playwrightLock = new Mutex();

// Runtime Data Containers
const state = {
    browser: null,
    sharedPage: null,
    
    // Sets & Maps
    waitingBroadcastInput: new Set(),
    broadcastMessage: {},
    verifiedUsers: new Set(),
    waitingAdminInput: new Set(),
    manualRangeInput: new Set(),
    get10RangeInput: new Set(),
    waitingDanaInput: new Set(),
    pendingMessage: {},
    lastUsedRange: {}
};

module.exports = {
    playwrightLock,
    state
};
