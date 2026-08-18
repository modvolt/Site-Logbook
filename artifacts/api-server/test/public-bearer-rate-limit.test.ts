import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { limitPublicBearerRequests } from "../src/middlewares/public-bearer-rate-limit";

describe("pre-parser public Bearer rate limiting", () => {
  it("separates family and read/mutation buckets without keying on credentials", async () => {
    const app = express();
    app.use(limitPublicBearerRequests);
    app.use((_req, res) => res.status(204).end());

    for (let index = 0; index < 30; index += 1) {
      await request(app).post(`/api/sign?attempt=${index}`).expect(204);
    }
    const blockedMutation = await request(app)
      .post("/api/sign")
      .set("Authorization", `Bearer ${"s".repeat(43)}`)
      .expect(429);
    expect(JSON.stringify(blockedMutation.body)).not.toContain("s".repeat(43));
    expect(blockedMutation.headers).toHaveProperty("ratelimit");

    await request(app).post("/api/ppe/sign").expect(204);

    for (let index = 0; index < 120; index += 1) {
      await request(app).get(`/api/sign?read=${index}`).expect(204);
    }
    await request(app).get("/api/sign").expect(429);
    await request(app).get("/api/quotes/public").expect(204);
  });
});
