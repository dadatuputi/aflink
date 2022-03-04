$(document).ready(function () {
  
  var searchParams = new URLSearchParams(window.location.search);

  // Filter links based on search query
  $("#search-form").on(
    "change keyup paste mouseup search",
    function (event) {
      var value = $(this).val().toLowerCase();
      
      // Hide everything
      $('#link-list a, #link-list .category').toggle(false);
      // Show links that contain text
      var links = $('#link-list a').filter(function(){
        return $(this).text().toLowerCase().indexOf(value) > -1;
      })
      links.toggle(true);
      // Show link category
      links.siblings('.category').toggle(true);

      // Update URL with new search params
      searchParamsString = ""
      if (value) {
        searchParams.set("q", $(this).val());
        searchParamsString = `?${searchParams.toString()}`
      }
      var newurl = `${window.location.origin}${window.location.pathname}${searchParamsString}`
      window.history.replaceState({ path: newurl }, "", newurl);

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
