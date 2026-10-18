import { defineConfig } from "vite";
import { voidPlugin } from "void";
import { voidReact } from "@void/react/plugin";
import { excludeUnusedYjsProviders } from "@todoflare/board/vite";

export default defineConfig({
	plugins: [excludeUnusedYjsProviders(), voidPlugin(), voidReact()],
});
