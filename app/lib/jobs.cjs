const ORIGIN = "https://thaichinesejobs.com";
const PROVINCES = [
  "bangkok",
  "chonburi",
  "rayong",
  "chachoengsao",
  "samut_prakan",
  "pathum_thani",
  "ayutthaya",
  "prachinburi",
  "samut_sakhon",
  "nonthaburi",
  "saraburi",
  "chiang_mai",
];
function plain(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) =>
      String.fromCodePoint(
        Math.min(
          parseInt(
            n[0].toLowerCase() === "x" ? n.slice(1) : n,
            n[0].toLowerCase() === "x" ? 16 : 10,
          ) || 32,
          0x10ffff,
        ),
      ),
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}
function jobFromHTML(html, id, now = new Date()) {
  const blocks = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].flatMap((m) => {
    try {
      const data = JSON.parse(m[1]);
      return Array.isArray(data) ? data : data["@graph"] || [data];
    } catch {
      return [];
    }
  });
  const job = blocks.find((b) => b["@type"] === "JobPosting");
  if (!job || String(job.identifier?.value) !== String(id))
    throw new Error("职位详情缺少可核对的数据");
  if (job.validThrough && new Date(job.validThrough) < now) return null;
  const summary = plain(
    html.match(/<span\s+class=["']jd-pay["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] ||
      "薪资未公开",
  );
  const header = plain(
    html.match(
      /<section\b[^>]*class=["'][^"']*jd-hero[^"']*["'][^>]*>([\s\S]*?)<\/section>/i,
    )?.[1] ||
      html.match(
        /<div\b[^>]*class=["'][^"']*jd-meta[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
      )?.[1] ||
      "",
  );
  const address = job.jobLocation?.address || {};
  return {
    id: String(id),
    title: String(job.title).slice(0, 180),
    company: String(job.hiringOrganization?.name || "").slice(0, 200),
    province: address.addressRegion || "",
    locality: address.addressLocality || "",
    salary: summary,
    requirements: String(job.qualifications || "").slice(0, 300),
    benefits: String(job.jobBenefits || "").slice(0, 500),
    description: plain(job.description).slice(0, 5000),
    publishedAt: job.datePosted || "",
    validThrough: job.validThrough || "",
    needsConfirmation: html.includes("企业近期没有确认这个岗位仍在招聘"),
    publicSummary: header.slice(0, 1200),
    url: ORIGIN + "/jobs/" + id + "?lang=zh",
    checkedAt: now.toISOString(),
  };
}
class JobCatalog {
  constructor({ fetchImpl = fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
  }
  async html(url) {
    const parsed = new URL(url);
    if (parsed.origin !== ORIGIN || !/^\/jobs(?:\/\d+)?$/.test(parsed.pathname))
      throw new Error("只查询指定招聘网站的公开职位");
    const response = await this.fetchImpl(url, {
      headers: {
        "User-Agent": "Huixiang-JobAssistant/0.2",
        Accept: "text/html",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        "招聘网站查询失败（" + response.status + "），本次不引用旧数据",
      );
    const length = Number(response.headers?.get("content-length") || 0);
    if (length > 2000000) throw new Error("职位页面过大");
    const text = await response.text();
    if (text.length > 2000000) throw new Error("职位页面过大");
    return text;
  }
  async search(plan) {
    const q = String(plan.q || "")
        .trim()
        .slice(0, 50),
      province = PROVINCES.includes(plan.province) ? plan.province : "";
    const id = /^\d{1,9}$/.test(String(plan.jobId || ""))
      ? String(plan.jobId)
      : "";
    const key = JSON.stringify({ q, province, id }),
      cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 120000) return cached.result;
    const url = new URL("/jobs", ORIGIN);
    url.searchParams.set("lang", "zh");
    if (q) url.searchParams.set("q", q);
    if (province) url.searchParams.set("province", province);
    const listing = id ? "" : await this.html(url.href);
    const ids = id
      ? [id]
      : [
          ...new Set(
            [
              ...listing.matchAll(/href=["']\/jobs\/(\d+)(?:\?[^"']*)?["']/g),
            ].map((m) => m[1]),
          ),
        ].slice(0, 3);
    const settled = await Promise.allSettled(
      ids.map(async (id) =>
        jobFromHTML(await this.html(ORIGIN + "/jobs/" + id + "?lang=zh"), id),
      ),
    );
    const jobs = settled
      .filter((r) => r.status === "fulfilled" && r.value)
      .map((r) => r.value);
    if (
      ids.length &&
      !jobs.length &&
      settled.every((r) => r.status === "rejected")
    )
      throw new Error("暂时无法核对岗位详情，请人工查看网站");
    const result = {
      query: { q, province },
      searchUrl: url.href,
      jobs,
      checkedAt: new Date().toISOString(),
    };
    this.cache.set(key, { at: Date.now(), result });
    if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    return result;
  }
}
module.exports = { JobCatalog, jobFromHTML, plain, PROVINCES };
