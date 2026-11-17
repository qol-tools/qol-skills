'use strict';

const state = { target: null, messages: null, baseline: null, pathIsNew: true };

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

function pathIsNew() {
    return state.pathIsNew;
}

// baseline is the file's content at the lint base, or null when linting
// whole files: rules about added code then treat every line as added.
function run(filePath, evaluate, baselineContent = null, { pathIsNew: isNew = baselineContent === null } = {}) {
    state.target = filePath;
    state.messages = [];
    state.baseline = baselineContent;
    state.pathIsNew = isNew;
    try {
        evaluate();
        return state.messages;
    } finally {
        state.target = null;
        state.messages = null;
        state.baseline = null;
        state.pathIsNew = true;
    }
}

module.exports = { active, baseline, isTarget, pathIsNew, report, run };
