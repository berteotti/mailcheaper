import { register } from "node:module";

// Lets tests import server actions and route handlers as they are: the @/ alias and cloudflare:workers resolve
// (bindings from tests/helpers), and Next.js request APIs, SES, DNS lookups (domain checks and imports' mail
// domains), the DNS helper, image downloads and client metadata documents are replaced by the stubs in tests/stubs.
register("./hooks.mjs", import.meta.url);
