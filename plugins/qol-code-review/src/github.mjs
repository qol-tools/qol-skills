const PR_FIELDS = "number,url,title,body,baseRefName,baseRefOid,headRefName,headRefOid,isDraft,state,closingIssuesReferences";
export const PULL_REQUEST_URL = /^https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
const PULL_REQUEST_REPO = /github\.com\/([^/]+\/[^/]+)\/pull\//;

export function repoOfPullRequest(url) {
  return PULL_REQUEST_REPO.exec(url ?? "")?.[1] ?? null;
}

export function viewPullRequest(gh, selector) {
  const raw = gh(["pr", "view", String(selector), "--json", PR_FIELDS], { allowFail: true });
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function pullRequestInfo(view) {
  return {
    number: view.number,
    url: view.url,
    title: view.title ?? "",
    body: view.body ?? "",
    draft: Boolean(view.isDraft),
    state: view.state ?? null,
    base_ref: view.baseRefName,
    head_ref: view.headRefName,
    head_sha: view.headRefOid,
    closing_issues: (view.closingIssuesReferences ?? []).map((issue) => issue.url ?? issue.number).filter(Boolean),
  };
}

export function linkedIssues(gh, pr) {
  const own = `${(pr?.url ?? "").replace(/\/pull\/\d+$/, "")}/issues/`;
  return (pr?.closing_issues ?? []).filter((ref) => String(ref).startsWith(own)).slice(0, 3).flatMap((ref) => {
    const raw = gh(["issue", "view", String(ref), "--json", "number,title,body"], { allowFail: true });
    if (!raw) return [];
    try {
      const issue = JSON.parse(raw);
      return [{ ref: `#${issue.number}`, title: issue.title ?? "", body: issue.body ?? "" }];
    } catch {
      return [];
    }
  });
}
