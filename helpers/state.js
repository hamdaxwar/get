const state = {
    
    waitingBroadcastInput: new Set(),
    broadcastMessage: {},
    verifiedUsers: new Set(),
    waitingAdminInput: new Set(),
    manualRangeInput: new Set(),
    get10RangeInput: new Set(),
    waitingDanaInput: new Set(),
    pendingMessage: {},
    lastUsedRange: {},
    lastBotMessage: {}
};

module.exports = {
    state
};
