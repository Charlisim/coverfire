#!/usr/bin/env node
import { run } from "../lib/coverfire.js";

const code = await run(process.argv.slice(2), process.env);
process.exit(code);
