$(document).ready(function () {
  $("#search-form").on(
    "change keyup paste mouseup search",
    function (event) {
      var value = $(this).val().toLowerCase();
      $("#link-list a").filter(function () {
        $(this).toggle($(this).text().toLowerCase().indexOf(value) > -1);
      });

      // If no links displayed, show alert
      if (!$("#link-list a:visible")[0]) {
        $("#list p").removeAttr('hidden');
        $("#list p em").text($(this).val());
      } else {
        $("#list p").attr('hidden','hidden');
      }

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

  // Parse URL parameters for search query
  var searchParams = new URLSearchParams(window.location.search);
  if (searchParams.has("q") === true) {
    $("#search-form").val(searchParams.get("q")).change();
  }
});
