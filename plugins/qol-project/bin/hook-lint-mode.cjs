'use strict';

const state = { target: null, messages: null };

function active() {
    return state.messages !== null;
}

function isTarget(filePath) {
    return active() && filePath === state.target;
}

function report(stream, text) {
    if (active()) state.messages.push(text);
    else stream.write(text);
}

function run(filePath, evaluate) {
    state.target = filePath;
    state.messages = [];
    try {
        evaluate();
        return state.messages;
    } finally {
        state.target = null;
        state.messages = null;
    }
}

module.exports = { active, isTarget, report, run };
