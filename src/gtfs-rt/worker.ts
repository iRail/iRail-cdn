import { collectMinute } from './collect.ts';
import type { Env } from './env.ts';

// Cron-only Worker: no fetch handler and no route. Clients read the public R2 custom domain, which keeps every
// download out of the Workers request quota.
export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    await collectMinute(env, controller.scheduledTime);
  },
} satisfies ExportedHandler<Env>;
