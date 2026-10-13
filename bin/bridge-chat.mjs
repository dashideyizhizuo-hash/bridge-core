#!/usr/bin/env node
import { main } from '../src/chat-cli.mjs';

process.exitCode=await main();
