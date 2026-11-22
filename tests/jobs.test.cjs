const test = require("node:test"),
  assert = require("node:assert/strict");
const { JobCatalog, jobFromHTML } = require("../app/lib/jobs.cjs");
const markup = (id, expires = "2027-01-01") =>
  `<script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "中泰翻译", identifier: { value: id }, description: "<p>工厂现场翻译</p>", validThrough: expires, hiringOrganization: { name: "企业甲" } })}</script><span class="jd-pay">฿30K–40K</span><section class="jd-hero">本科 1–3年</section><p title="企业近期没有确认这个岗位仍在招聘">近期未更新</p>`;
test("岗位只用结构化详情，过期岗位和错误ID不作为依据", () => {
  const job = jobFromHTML(markup("12"), "12", new Date("2026-11-23"));
  assert.equal(job.salary, "฿30K–40K");
  assert.equal(job.needsConfirmation, true);
  assert.equal(job.description, "工厂现场翻译");
  assert.equal(jobFromHTML(markup("12", "2020-01-01"), "12"), null);
  assert.throws(() => jobFromHTML(markup("12"), "13"));
});
test("岗位检索只请求指定网站并保留地区、详情和原始链接", async () => {
  const urls = [];
  const catalog = new JobCatalog({
    fetchImpl: async (url) => {
      urls.push(url);
      return {
        ok: true,
        headers: { get: () => null },
        text: async () =>
          url.includes("/jobs/12")
            ? markup("12")
            : '<a href="/jobs/12">翻译</a><a href="https://other.example/private">不读</a>',
      };
    },
  });
  const r = await catalog.search({ q: "翻译", province: "rayong" });
  assert.equal(r.jobs.length, 1);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => u.startsWith("https://thaichinesejobs.com/")));
  assert.ok(urls[0].includes("province=rayong"));
  await catalog.search({ q: "翻译", province: "rayong" });
  assert.equal(urls.length, 2);
});
test("详情失败不把旧缓存或其他网页内容当作招聘数据", async () => {
  const catalog = new JobCatalog({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(() => catalog.search({ q: "翻译" }), /查询失败/);
});
