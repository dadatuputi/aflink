$(document).ready(function () {

  var searchParams = new URLSearchParams(window.location.search);

  // Filter links based on search query
  $("#search-form").on(
    "change keyup paste mouseup search",
    function (event) {
      var value = $(this).val().toLowerCase();
      $("#link-list a").filter(function () {
        $(this).toggle($(this).text().toLowerCase().indexOf(value) > -1);
      });

      // Update URL with new search params
      if (value) {
        searchParams.set("q", $(this).val());
        var newurl = `${window.location.origin}${window.location.pathname}?${searchParams.toString()}`
        window.history.replaceState({ path: newurl }, "", newurl);
      }

      // If no links displayed, show alert
      if (!$("#link-list a:visible")[0]) {
        $("#list p").removeAttr('hidden');
        $("#list p em").text(value);
      } else {
        $("#list p").attr('hidden','hidden');
      }

      // On enter keypress, follow first link
      if (
        value &&
        event.type === "keyup" &&
        event.originalEvent.key === "Enter"
      ) {
        if ($("#link-list a:visible")[0]) {
          $("#link-list a:visible")[0].click();
        }
      }
    }
  );

  // Update search field based on parameters
  if (searchParams.has("q") === true) {
    $("#search-form").val(searchParams.get("q")).change();
  }
});
