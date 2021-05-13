$(document).ready(function () {
  $("#search-form").on(
    "change keyup paste mouseup search",
    function (event) {
      var value = $(this).val().toLowerCase();
      $("#link-list a").filter(function () {
        $(this).toggle($(this).text().toLowerCase().indexOf(value) > -1);
      });

      // On enter keypress, follow first link
      if (
        $(this).val() &&
        event.type === "keyup" &&
        event.originalEvent.key === "Enter"
      ) {
        if ($("#link-list a:visible")[0]) {
          $("#link-list a:visible")[0].click();
        }
      }
    }
  );
});