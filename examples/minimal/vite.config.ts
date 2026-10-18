import { defineConfig } from "vite";
import { excludeUnusedYjsProviders } from "@todoflare/board/vite";

export default defineConfig({
	plugins: [excludeUnusedYjsProviders()],
});
