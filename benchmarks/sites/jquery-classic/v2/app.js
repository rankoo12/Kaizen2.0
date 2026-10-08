/* Harbor Desk v2 — same behaviors as v1 minus the removed Reports feature.
   The reports handler is gone with the feature; everything else unchanged. */
/* global $ */
$(function () {
  $('.tab').on('click', function () {
    $('.tab').removeClass('active');
    $(this).addClass('active');
    $('.tab-pane').addClass('hidden');
    var pane = '#pane-' + this.id.replace('tab-', '');
    $(pane).removeClass('hidden');
  });

  $('.acc-head').on('click', function () {
    var body = $(this).next('.acc-body');
    var wasOpen = body.hasClass('open');
    $('.acc-body').removeClass('open');
    if (!wasOpen) body.addClass('open');
  });

  $('#open-announcement').on('click', function () { $('#modal-scrim').removeClass('hidden'); });
  $('#modal-close').on('click', function () { $('#modal-scrim').addClass('hidden'); });

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
