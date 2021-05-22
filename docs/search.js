$(document).ready(function () {
  const query = new URLSearchParams(window.location.search);
  $("#search-form").on(
    "change keyup paste mouseup search",
    function (event) {
      var value = $(this).val().toLowerCase();
      if (history.pushState) {
        query.set("s", value);
        var newurl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?${query.toString()}`
        window.history.replaceState({ path: newurl }, "", newurl);
      }
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
  const searchQuery = (query.get("s"));
  if (searchQuery) {
    $("#search-form").val(searchQuery);
    $("#search-form").trigger("change")
  }

});