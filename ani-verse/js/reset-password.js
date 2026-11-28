(function () {
  var msg = document.getElementById("reset-msg");
  var form = document.getElementById("reset-form");
  var submitBtn = document.getElementById("btn-reset-submit");
  var token = new URLSearchParams(window.location.search).get("token") || "";

  function showMsg(text, kind) {
    msg.textContent = text;
    msg.className = "reset-msg " + kind;
    msg.style.display = "block";
  }

  if (!token) {
    form.style.display = "none";
    showMsg("This password link is invalid or has expired.", "error");
    return;
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    msg.style.display = "none";
    var pw = document.getElementById("new-password").value;
    var confirm = document.getElementById("confirm-password").value;
    if (pw.length < 8 || pw.length > 200) {
      showMsg("Password must be between 8 and 200 characters.", "error");
      return;
    }
    if (pw !== confirm) {
      showMsg("The two passwords don't match.", "error");
      return;
    }
    submitBtn.disabled = true;
    var res;
    try {
      res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token: token, newPassword: pw }),
      });
    } catch (err) {
      submitBtn.disabled = false;
      showMsg("Something went wrong. Please try again.", "error");
      return;
    }
    submitBtn.disabled = false;
    var data = await res.json().catch(function () { return null; });
    if (res.ok && data && data.ok) {
      form.style.display = "none";
      showMsg("Your password has been set. You can now sign in.", "success");
    } else {
      showMsg(
        (data && data.error && data.error.message) || "This password link is invalid or has expired.",
        "error"
      );
    }
  });
})();
