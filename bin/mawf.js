#!/usr/bin/env node
import { main } from "../src/index.js";
const code = main();
// Command handlers may return a numeric exit code (e.g. knowledge verify,
// archify adapter); existing handlers signal via process.exitCode directly —
// both paths must land on the real process exit code.
if (typeof code === "number") process.exitCode = code;
