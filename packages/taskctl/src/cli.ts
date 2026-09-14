#!/usr/bin/env node

import { runTaskctl } from "./index.js";

process.exitCode = await runTaskctl(process.argv.slice(2));
