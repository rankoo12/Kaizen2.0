/* Harbor Desk — jQuery DOM manipulation, the classic way.
   Tabs show/hide panes, the accordion toggles bodies, the modal is a scrim,
   and the activity table rows are CREATED on demand — a mix of exists-but-
   hidden and not-in-DOM-until-clicked elements. */
/* global $ */
$(function () {
  // Tabs
  $('.tab').on('click', function () {
    $('.tab').removeClass('active');
    $(this).addClass('active');
    $('.tab-pane').addClass('hidden');
    var pane = '#pane-' + this.id.replace('tab-', '');
    $(pane).removeClass('hidden');
  });

  // Accordion — one body open at a time.
  $('.acc-head').on('click', function () {
    var body = $(this).next('.acc-body');
    var wasOpen = body.hasClass('open');
    $('.acc-body').removeClass('open');
    if (!wasOpen) body.addClass('open');
  });

  // Modal
  $('#open-announcement').on('click', function () { $('#modal-scrim').removeClass('hidden'); });
  $('#modal-close').on('click', function () { $('#modal-scrim').addClass('hidden'); });

  // Reports
  $('#load-report').on('click', function () { $('#report-status').removeClass('hidden'); });

  // Activity — rows do not exist until loaded.
  var ENTRIES = [
    ['09:12', 'Amara', 'closed ticket #4411'],
    ['09:48', 'Ben', 'replied to ticket #4418'],
    ['10:03', 'Carla', 'escalated ticket #4402'],
  ];
  $('#load-entries').on('click', function () {
    var body = $('#activity-body').empty();
    ENTRIES.forEach(function (e) {
      body.append($('<tr>').append($('<td>').text(e[0]), $('<td>').text(e[1]), $('<td>').text(e[2])));
    });
    $('#activity-table').removeClass('hidden');
  });
});
