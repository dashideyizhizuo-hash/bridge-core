#!/usr/bin/env node
import { main } from '../src/task-cli.mjs';

process.exitCode=await main();
