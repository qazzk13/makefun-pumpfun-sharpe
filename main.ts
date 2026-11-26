// Sharpe Sprint bot entrypoint: the grader runs `node /bot/main.ts`.
// Session: 3f90fb62-686b-461e-9526-3802c3421631
import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
