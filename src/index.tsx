import { Hono } from "hono";

const app = new Hono();

const routes = app.get("/api/clock", (c) => {
	return c.json({
		time: new Date().toLocaleTimeString(),
	});
});

export type AppType = typeof routes;

export default app;
