$(document).ready(function () {
  
  var searchParams = new URLSearchParams(window.location.search);
  // If search string has a newline at the end, it comes from autocomplete, so automatically go to the first result
  // https://bugzilla.mozilla.org/show_bug.cgi?id=386591#c32
  const autocompleted = (searchParams.has("q") && searchParams.get("q").at(-1) === '\n')

  function updateSearchParams(newParams) {
    var params = ""
    if (newParams) {
      searchParams.set("q", newParams);
      params = '?'+searchParams.toString()
    } else {
      searchParams.delete("q")
    }
    var newurl = window.location.origin+window.location.pathname+params
    window.history.replaceState({ path: newurl }, "", newurl);
  }

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
      updateSearchParams($(this).val())

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

  // Update search field based on parameters on pageload
  if (searchParams.has("q") === true) {
    if (autocompleted) {
      updateSearchParams(searchParams.get("q").trimEnd()) // remove newline before adding search query to textbox
    }

    $("#search-form").val(searchParams.get("q")).change();

    // Handle autocomplete
    if (autocompleted && $("#link-list a:visible")[0]) {
      $("#link-list a:visible")[0].click();
    }
  }

});
