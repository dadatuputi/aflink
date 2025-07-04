$(document).ready(function () {

  const searchParams = new URLSearchParams(window.location.search);

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

  // If search string has a hidden space anywhere inside it, it comes from autocomplete, so automatically go to the first result
  // https://bugzilla.mozilla.org/show_bug.cgi?id=386591#c32
  const autocompleted = (searchParams.has("q") && searchParams.get("q").includes('​'));
  
  // Show modal after clicking a link
  const my_modal = new bootstrap.Modal(document.getElementById('exit-modal'), {focus: false});
  $("#link-list .list-group-item a:first-child").on('click', function(event) {
    $('#exit-modal .modal-header .title').text($(this).text());
    $('#exit-modal .link').text($(this).prop('href'));
    my_modal.toggle();
  });

  // Filter links based on search query
  $("#search-form").on(
    "change keyup paste search",
    function (event) {
      var value = $(this).val().toLowerCase();
      
      // Hide everything
      $('#link-list .category, #link-list .link-container').toggle(false);

      // Show links that contain text
      var links = $('#link-list .link-container').filter(function(){
        return $(this).find('a:first-child').text().toLowerCase().indexOf(value) > -1;
      })

      // Go to first link if autocomplete
      if (autocompleted && links[0]) {
        $(links[0]).find('a.main-link')[0].click();
      }
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
      // Remove all the characters after the hidden space, inclusive
      const query = searchParams.get("q");
      const cleanQuery = query.slice(0, query.indexOf('​'));
      searchParams.set("q", cleanQuery);
    }

    $("#search-form").val(searchParams.get("q")).change();
  }

});