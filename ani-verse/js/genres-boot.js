document.addEventListener("DOMContentLoaded", function () {
  var randBtn = document.getElementById("btn-genres-random");
  if (randBtn) {
    randBtn.addEventListener("click", function () {
      var shuffleBtn = document.getElementById("btn-random-anime");
      if (shuffleBtn) shuffleBtn.click();
    });
  }
});
