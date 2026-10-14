// Stands in for "cloudflare:workers": tests put their bindings (DB, buckets, queues) on env.
export const env = {};

export class DurableObject {
	constructor(ctx, env) {
		this.ctx = ctx;
		this.env = env;
	}
}
