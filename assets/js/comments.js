/* Utterances 댓글 모듈 로딩 관련 동작들 */

function 댓글_모듈_로드() {
  const wrapper = document.getElementById("comments-wrapper");
  wrapper.innerHTML = "";

  const script = document.createElement("script");
  script.src = "https://utteranc.es/client.js";
  script.setAttribute("repo", wrapper.dataset.repo);
  script.setAttribute("issue-term", "pathname");
  script.setAttribute("label", "comment 🌟");
  script.setAttribute("theme", "preferred-color-scheme");
  script.setAttribute("crossorigin", "anonymous");
  script.async = true;

  wrapper.appendChild(script);
}

document.addEventListener("DOMContentLoaded", () => {
  댓글_모듈_로드();
});
