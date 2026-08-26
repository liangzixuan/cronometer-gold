import assert from "node:assert/strict";

function exactLineIndexes(lines, expected) {
  return lines.flatMap((line, index) => (line === expected ? [index] : []));
}

export function workflowJob(source, name) {
  const lines = source.split("\n");
  assert.equal(exactLineIndexes(lines, "jobs:").length, 1, "workflow must define jobs once");

  const starts = exactLineIndexes(lines, `  ${name}:`);
  assert.equal(starts.length, 1, `workflow must define job ${name} exactly once`);

  const start = starts[0];
  const relativeEnd = lines
    .slice(start + 1)
    .findIndex((line) => /^ {2}[a-zA-Z0-9_-]+:$/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

export function workflowStep(job, name) {
  const lines = job.split("\n");
  const starts = exactLineIndexes(lines, `      - name: ${name}`);
  assert.equal(starts.length, 1, `job must define step ${name} exactly once`);

  const start = starts[0];
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^ {6}- /.test(line));
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd;
  return lines.slice(start, end).join("\n");
}

export function assertUnconditionalStep(step, name) {
  assert.doesNotMatch(step, /^ {8}if:/m, `${name} must be unconditional`);
  assert.doesNotMatch(step, /^ {8}continue-on-error:/m, `${name} must not continue on error`);
}

export function assertStepOrder(job, names) {
  let previous = -1;
  for (const name of names) {
    const step = workflowStep(job, name);
    const index = job.indexOf(step);
    assert.ok(index > previous, `${name} must remain after the preceding required step`);
    previous = index;
  }
}
