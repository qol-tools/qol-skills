export const EXIT = { usage: 2, input: 3, tool: 4, contract: 5 };

export class ReviewError extends Error {
  constructor(code, message, problems = []) {
    super(message);
    this.code = code;
    this.problems = problems;
  }
}

export const usageError = (message) => new ReviewError(EXIT.usage, message);
export const inputError = (message) => new ReviewError(EXIT.input, message);
export const toolError = (message) => new ReviewError(EXIT.tool, message);
export const contractError = (message, problems) => new ReviewError(EXIT.contract, message, problems);
