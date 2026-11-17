'use strict';

const state = { target: null, messages: null, baseline: null };

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

function baseline() {
    return state.baseline;
}

// baseline is the file's content at the lint base, or null when linting
// whole files: rules about added code then treat every line as added.
function run(filePath, evaluate, baselineContent = null) {
    state.target = filePath;
    state.messages = [];
    state.baseline = baselineContent;
    try {
        evaluate();
        return state.messages;
    } finally {
        state.target = null;
        state.messages = null;
        state.baseline = null;
    }
}

module.exports = { active, baseline, isTarget, report, run };
