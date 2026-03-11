// snorr.io redirect worker
// /install → raw install script on GitHub

const INSTALL_URL = "https://raw.githubusercontent.com/snorrio/snorrio/main/install.sh";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === "/install" || url.pathname === "/install.sh") {
      return Response.redirect(INSTALL_URL, 302);
    }

    // Root → GitHub repo
    if (url.pathname === "/" || url.pathname === "") {
      return Response.redirect("https://github.com/snorrio/snorrio", 302);
    }

    return new Response("Not found", { status: 404 });
  },
};
