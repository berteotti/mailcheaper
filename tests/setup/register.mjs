import { register } from "node:module";

// Lets tests import server actions, route handlers and components as they are: the @/ alias and cloudflare:workers
// resolve (bindings from tests/helpers), JSX compiles, and Next.js request APIs, links and images, SES, DNS lookups
// (imports' mail domains), archive host checks, the DNS helper, image downloads and client metadata documents are
// replaced by the stubs in tests/stubs.
register("./hooks.mjs", import.meta.url);
