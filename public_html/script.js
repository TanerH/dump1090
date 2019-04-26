// -*- mode: javascript; indent-tabs-mode: nil; c-basic-offset: 8 -*-
"use strict";

// Define our global variables
var OLMap         = null;
var StaticFeatures = new ol.Collection();
var SiteCircleFeatures = new ol.Collection();
var PlaneIconFeatures = new ol.Collection();
var PlaneTrailFeatures = new ol.Collection();
var Planes        = {};
var PlanesOrdered = [];
var PlaneFilter   = {};
var SelectedPlane = null;
var SelectedAllPlanes = false;
var HighlightedPlane = null;
var FollowSelected = false;
var infoBoxOriginalPosition = {};
var customAltitudeColors = true;

var SpecialSquawks = {
        '7500' : { cssClass: 'squawk7500', markerColor: 'rgb(255, 85, 85)', text: 'Aircraft Hijacking' },
        '7600' : { cssClass: 'squawk7600', markerColor: 'rgb(0, 255, 255)', text: 'Radio Failure' },
        '7700' : { cssClass: 'squawk7700', markerColor: 'rgb(255, 255, 0)', text: 'General Emergency' }
};

// Get current map settings
var CenterLat, CenterLon, ZoomLvl, MapType;

var Dump1090Version = "unknown version";

var maxRangeRing = 300;         // Default
var maxRangeInit = 1;

var ErrorRefreshMultiplier = 5; // This is a multiplier, and should be at least 2, in order to make sense.

// We normally will list all
var hideOffscreenAircraft = false;

// vars for Background Mode
var enableBG = 1;
var BGRefreshInterval = DefaultRefreshInterval * 3;   // Sane default
var BGTrigger = 0;

// Do we want to highlight US Military aircraft?
var highlightUSMil = 0;

var RefreshInterval = DefaultRefreshInterval;
var ReaperInterval  = 60000;
var RefreshIntervalWord = 'fast';

var wasPaused = 0;
var refRefresh;
var refBackground;
var refResolutionChange;

var PlaneRowTemplate = null;

var TotalPlaneList = 0;
var OffscreenAircraft = 0;
var TrackedAircraft = 0;
var VisibleAircraft = 0;
var TrackedAircraftPositions = 0;
var TrackedHistorySize = 0;

var SitePosition = null;

var ReceiverClock = null;

var LastReceiverTimestamp = 0;
var StaleReceiverCount = 0;
var StaleRefreshInterval = DefaultRefreshInterval;
var FetchPending = null;

var MessageCountHistory = [];
var MessageRate = 0;

// For stale positions, we have green, yellow, orange, red.
var posYellow = 10;
var posOrange = 30;
var posRed = 45;
var stalePos = posYellow;

var NBSP='\u00a0';

// Bullets to be used by "position age" in the Age column
var normalBULL='\u2022';
var largeBULL='\u2B24';
var mediumBULL='\u26AB';
var BULL = largeBULL;

var layers;

// piaware vs flightfeeder
var isFlightFeeder = false;

function processReceiverUpdate(data) {
	// Loop through all the planes in the data packet
        var now = data.now;
        var acs = data.aircraft;

        // Detect stats reset
        if (MessageCountHistory.length > 0 && MessageCountHistory[MessageCountHistory.length-1].messages > data.messages) {
                MessageCountHistory = [{'time' : MessageCountHistory[MessageCountHistory.length-1].time,
                                        'messages' : 0}];
        }

        // Note the message count in the history
        MessageCountHistory.push({ 'time' : now, 'messages' : data.messages});
        // .. and clean up any old values
        if ((now - MessageCountHistory[0].time) > 30)
                MessageCountHistory.shift();

	// Save some cpu and set this once, and not every iteration of the loop
	var mapCanvas = $('#map_canvas');
	var mapExtent = getExtent(0, 0, mapCanvas.width(), mapCanvas.height());

	for (var j=0; j < acs.length; j++) {
                var ac = acs[j];
                var hex = ac.hex;
                var squawk = ac.squawk;
                var plane = null;
		var newplane = 0;

		// Do we already have this plane object in Planes?
		// If not make it.

		if (Planes[hex]) {
			newplane = 0;
			plane = Planes[hex];
		} else {
			newplane = 1;
			plane = new PlaneObject(hex);
                        plane.filter = PlaneFilter;
                        plane.tr = PlaneRowTemplate.cloneNode(true);

                        if (hex[0] === '~') {
                                // Non-ICAO address
                                plane.tr.cells[0].textContent = hex.substring(1);
                                $(plane.tr).css('font-style', 'italic');
                        } else {
                                plane.tr.cells[0].textContent = hex;
                        }

                        // set flag image if available
                        if (ShowFlags && plane.icaorange.flag_image !== null) {
                                $('img', plane.tr.cells[1]).attr('src', FlagPath + plane.icaorange.flag_image);
                                $('img', plane.tr.cells[1]).attr('title', plane.icaorange.country);
                        } else {
                                $('img', plane.tr.cells[1]).css('display', 'none');
                        }

                        plane.tr.addEventListener('click', function(h, evt) {
                                if (evt.srcElement instanceof HTMLAnchorElement) {
                                        evt.stopPropagation();
                                        return;
                                }

                                if (!$("#map_container").is(":visible")) {
                                        showMap();
                                }
                                selectPlaneByHex(h, false);
                                adjustSelectedInfoBlockPosition();
                                evt.preventDefault();
                        }.bind(undefined, hex));

                        plane.tr.addEventListener('dblclick', function(h, evt) {
                                if (!$("#map_container").is(":visible")) {
                                        showMap();
                                }
                                selectPlaneByHex(h, true);
                                adjustSelectedInfoBlockPosition();
                                evt.preventDefault();
                        }.bind(undefined, hex));

		}

		// Call the function update
		plane.updateData(now, ac);

		// Ok, we'll use this later (maybe).  Check to see if this aircraft is on the screen or not.
		// We calculate this every time, even if the hideOffscreenAircraft global is not set, so that it responds quickly when toggled
		plane.onscreen = false;
		if (plane.marker) {
        		var markerCoordinates = plane.marker.getGeometry().getCoordinates();
			var markerPosition = OLMap.getPixelFromCoordinate(markerCoordinates);
        		if (isPointInsideExtent(markerPosition[0], markerPosition[1], mapExtent)) {
				plane.onscreen = true;
			}
		}

		// This got moved outside the loop
		if (newplane) {
                        Planes[hex] = plane;
                        PlanesOrdered.push(plane);
		}
	}
}

function fetchData() {
        if (FetchPending !== null && FetchPending.state() == 'pending') {
                // don't double up on fetches, let the last one resolve
                return;
        }

        // We just came back from being paused - update the button
        if (wasPaused) {
                $("#pause60").html('<span class="buttonText">Pause 60s</span>');
                wasPaused = 0;
                clearInterval(refRefresh);
                refRefresh = window.setInterval(fetchData, RefreshInterval);
                updateRefreshRate();
        }

	FetchPending = $.ajax({ url: 'data/aircraft.json',
                                timeout: 5000,
                                cache: false,
                                dataType: 'json' });

        FetchPending.done(function(data) {
                var now = data.now;

                processReceiverUpdate(data);

                // update timestamps, visibility, history track for all planes - not only those updated
                for (var i = 0; i < PlanesOrdered.length; ++i) {
                        //var plane = PlanesOrdered[i];
                        PlanesOrdered[i].updateTick(now, LastReceiverTimestamp);
                }
                
		selectNewPlanes();
		refreshTableInfo();
		refreshSelected();
		refreshHighlighted();
                
                if (ReceiverClock) {
                        var rcv = new Date(now * 1000);
                        ReceiverClock.render(rcv.getUTCHours(),rcv.getUTCMinutes(),rcv.getUTCSeconds());
                }

                // Check for stale receiver data
                if (LastReceiverTimestamp === now) {
                        StaleReceiverCount++;

                        // Add some hysteresis to refreshes...
                        StaleRefreshInterval = (BGTrigger ? BGRefreshInterval : RefreshInterval) * (1 + (StaleReceiverCount/5));

                        if (StaleReceiverCount > 5) {
				var local_txt = "The data from dump1090 hasn't been updated in a while (" + StaleReceiverCount + " retries). Maybe dump1090 is no longer running?"
                                $("#update_error_detail").text(local_txt);
                                $("#update_error").css('display','block');

                                // Something is wrong, so back off refreshes a bunch...
                                StaleRefreshInterval = (BGTrigger ? BGRefreshInterval : RefreshInterval) * ErrorRefreshMultiplier;
                        }

                        clearInterval(refRefresh);
                        refRefresh = window.setInterval(fetchData, StaleRefreshInterval);
			updateRefreshRate();
                } else { 
                        // Clear this errorstate, and set the refresh interval back to normal
                        if (StaleReceiverCount !== 0) {
                                StaleReceiverCount = 0;
                                clearInterval(refRefresh);
                                refRefresh = window.setInterval(fetchData, (BGTrigger ? BGRefreshInterval : RefreshInterval));
                                $("#update_error").css('display','none');
                                updateRefreshRate();
                        }
                        LastReceiverTimestamp = now;
                        $("#update_error").css('display','none');
                }
	});

        FetchPending.fail(function(jqxhr, status, error) {
                $("#update_error_detail").text("AJAX call failed (" + status + (error ? (": " + error) : "") + "). Maybe dump1090 is no longer running?");
                $("#update_error").css('display','block');
        });
}

// Called by the decay timer when we get un-focused.  Kick the refresh delay up a notch
function goBackground() {
        if (wasPaused) {
                // Don't actually go background until AFTER we come back from paused, so for now, reset this trigger to check again
        	clearInterval(refBackground);
                refBackground = window.setInterval(goBackground, 1000);
                return;
        }
        BGTrigger = 1;
        clearInterval(refBackground);
        clearInterval(refRefresh);
	// Set this to 3x the normal refresh, but no more than 30 sec (sanity)
        BGRefreshInterval = RefreshInterval * 3;
	if (BGRefreshInterval > 30000)
		BGRefreshInterval = 30000
        refRefresh = window.setInterval(fetchData, BGRefreshInterval);
        updateRefreshRate();
}

var PositionHistorySize = 0;
function initialize() {
        // Set page basics
        document.title = PageName;

        flightFeederCheck();

        PlaneRowTemplate = document.getElementById("plane_row_template");

        refreshClock();

        $("#loader").removeClass("hidden");

        if (ExtendedData || window.location.hash == '#extended') {
                $("#extendedData").removeClass("hidden");
        }

        // Set up map/sidebar splitter
	$("#sidebar_container").resizable({
		handles: {
			w: '#splitter'
		},
		minWidth: 350
	});

	// Set up datablock splitter
	$('#selected_infoblock').resizable({
		handles: {
			s: '#splitter-infoblock'
		},
		containment: "#sidebar_container",
		minHeight: 50
	});

	$('#close-button').on('click', function() {
		if (SelectedPlane !== null) {
			var selectedPlane = Planes[SelectedPlane];
			SelectedPlane = null;
			selectedPlane.selected = null;
			selectedPlane.clearLines();
			selectedPlane.updateMarker();         
			refreshSelected();
			refreshHighlighted();
			$('#selected_infoblock').hide();
		}
	});

	// this is a little hacky, but the best, most consitent way of doing this. change the margin bottom of the table container to the height of the overlay
	$('#selected_infoblock').on('resize', function() {
		$('#sidebar_canvas').css('margin-bottom', $('#selected_infoblock').height() + 'px');
	});
	// look at the window resize to resize the pop-up infoblock so it doesn't float off the bottom or go off the top
	$(window).on('resize', function() {
		var topCalc = ($(window).height() - $('#selected_infoblock').height() - 60);
		// check if the top will be less than zero, which will be overlapping/off the screen, and set the top correctly. 
		if (topCalc < 0) {
			topCalc = 0;
			$('#selected_infoblock').css('height', ($(window).height() - 60) +'px');
		}
		$('#selected_infoblock').css('top', topCalc + 'px');
	});

	// to make the infoblock responsive 
	$('#sidebar_container').on('resize', function() {
		if ($('#sidebar_container').width() < 500) {
			$('#selected_infoblock').addClass('infoblock-container-small');
		} else {
			$('#selected_infoblock').removeClass('infoblock-container-small');
		}
	});
	
        // Set up event handlers for buttons
        $("#toggle_sidebar_button").click(toggleSidebarVisibility);
        $("#expand_sidebar_button").click(expandSidebar);
        $("#show_map_button").click(showMap);
        $("#min_col_button").click(showMinCol);
        $("#med_col_button").click(showMedCol);
        $("#max_col_button").click(showMaxCol);

        $("#pause60").click(pause60sec);
        $("#pause60").show();

        // Set initial element visibility
        $("#show_map_button").hide();
        $("#min_col_button").show();
        $("#med_col_button").show();
        $("#max_col_button").show();
        setColumnVisibility();

	// This is for "Background Mode" -- when we've not been focused for a bit
        // When not in focus for more than 15 (BGTimeout) sec, bump refresh interval up by 3x
        $(document).mouseleave(function(){
                BGTrigger = 0;
                if (enableBG) {
                        clearInterval(refBackground);
                        refBackground = window.setInterval(goBackground, BGTimeout);
                }
        });
        $(document).mouseenter(function(){
                if (enableBG) {
                	clearInterval(refBackground);
                	// We don't need to do this next part every time - only if the trigger fired.
                	if (BGTrigger !== 0) {
                        	clearInterval(refRefresh);
                        	refRefresh = window.setInterval(fetchData, RefreshInterval);
                        	updateRefreshRate();
                        	// Force an update
                        	fetchData();
                	}
		}
                BGTrigger = 0;
        });

        // Initialize other controls
        initializeUnitsSelector();

        // Set up altitude filter button event handlers and validation options
        $("#altitude_filter_form").submit(onFilterByAltitude);
        $("#altitude_filter_form").validate({
            errorPlacement: function(error, element) {
                return true;
            },
            
            rules: {
                minAltitude: {
                    number: true,
                    min: -99999,
                    max: 99999
                },
                maxAltitude: {
                    number: true,
                    min: -99999,
                    max: 99999
                }
            }
        });

        // check if the altitude color values are default to enable the altitude filter
        if (ColorByAlt.air.h.length === 3 && ColorByAlt.air.h[0].alt === 2000 && ColorByAlt.air.h[0].val === 20 && ColorByAlt.air.h[1].alt === 10000 && ColorByAlt.air.h[1].val === 140 && ColorByAlt.air.h[2].alt === 40000 && ColorByAlt.air.h[2].val === 300) {
            customAltitudeColors = false;
        }


        $("#altitude_filter_reset_button").click(onResetAltitudeFilter);

        $('#settingsCog').on('click', function() {
        	$('#settings_infoblock').toggle();
        });

        $('#settings_close').on('click', function() {
            $('#settings_infoblock').hide();
        });

        $('#groundvehicle_filter').on('click', function() {
        	filterGroundVehicles(true);
        	refreshSelected();
        	refreshHighlighted();
        	refreshTableInfo();
        });

        $('#blockedmlat_filter').on('click', function() {
        	filterBlockedMLAT(true);
        	refreshSelected();
        	refreshHighlighted();
        	refreshTableInfo();
        });

        $('#grouptype_checkbox').on('click', function() {
        	if ($('#grouptype_checkbox').hasClass('settingsCheckboxChecked')) {
        		sortByDistance();
        	} else {
        		sortByDataSource();
        	}
        	
        });

	// Range Circles
        $('#range300_checkbox').on('click', function() {
                maxRangeSelect(300);
        });
        $('#range400_checkbox').on('click', function() {
                maxRangeSelect(400);
        });
        $('#range500_checkbox').on('click', function() {
                maxRangeSelect(500);
        });

	// Refresh Speed slow/med/fast
        $('#refresh_slow_checkbox').on('click', function() {
                refreshSpeedSelect('slow');
        });
        $('#refresh_med_checkbox').on('click', function() {
                refreshSpeedSelect('med');
        });
        $('#refresh_fast_checkbox').on('click', function() {
                refreshSpeedSelect('fast');
        });

	// BG Mode yes/no
        $('#nobg_checkbox').on('click', function() {
                toggleBackgrounding(true);
        });

	// Hide altitude filter?
        $('#hide_alt_checkbox').on('click', function() {
                toggleAltitudeFilter(true);
        });

	// Highlight US Military aircraft?
        $('#highlight_us_mil_checkbox').on('click', function() {
                toggleHighlightUSMil(true);
        });

        $('#altitude_checkbox').on('click', function() {
        	toggleAltitudeChart(true);
        });

        $('#selectall_checkbox').on('click', function() {
        	if ($('#selectall_checkbox').hasClass('settingsCheckboxChecked')) {
        		deselectAllPlanes();
        	} else {
        		selectAllPlanes();
        	}
        });

	// Hide offscreen planes?
        $('#hide_offscreen_checkbox').on('click', function() {
                toggleHideOffscreen(true);
		refreshTableInfo();
        	refreshSelected();
        	refreshHighlighted();
        });

        // Force map to redraw if sidebar container is resized - use a timer to debounce
        var mapResizeTimeout;
        $("#sidebar_container").on("resize", function() {
            clearTimeout(mapResizeTimeout);
            mapResizeTimeout = setTimeout(updateMapSize, 10);
        });

        toggleBackgrounding(false);
        toggleAltitudeFilter(false);
        toggleHighlightUSMil(false);
        toggleHideOffscreen(false);
        filterGroundVehicles(false);
        filterBlockedMLAT(false);
        toggleAltitudeChart(false);

        // Get receiver metadata, reconfigure using it, then continue
        // with initialization
        $.ajax({ url: 'data/receiver.json',
                 timeout: 5000,
                 cache: false,
                 dataType: 'json' })

                .done(function(data) {
                        if (typeof data.lat !== "undefined") {
                                SiteShow = true;
                                SiteLat = data.lat;
                                SiteLon = data.lon;
                                DefaultCenterLat = data.lat;
                                DefaultCenterLon = data.lon;
                        }
                        
                        Dump1090Version = data.version;
                        RefreshInterval = data.refresh;
                        PositionHistorySize = data.history;
                })

                .always(function() {
                        initialize_map();
                        start_load_history();
                });
}

var CurrentHistoryFetch = null;
var PositionHistoryBuffer = [];
var HistoryItemsReturned = 0;
function start_load_history() {
	if (PositionHistorySize > 0 && window.location.hash != '#nohistory') {
		$("#loader_progress").attr('max',PositionHistorySize);
        	$("#loader_text").text("Starting history load (" + (PositionHistorySize-1) + " total)");
		console.log("Starting to load history (" + PositionHistorySize + " items)");
		//Load history items in parallel
		for (var i = 0; i < PositionHistorySize; i++) {
			load_history_item(i);
		}
	}
}

function load_history_item(i) {
        console.log("Loading history #" + i);
        $("#loader_progress").attr('value',i);

        $.ajax({ url: 'data/history_' + i + '.json',
                 timeout: 5000,
                 cache: false,
                 dataType: 'json' })

                .done(function(data) {
			PositionHistoryBuffer.push(data);
			HistoryItemsReturned++;
			$("#loader_progress").attr('value',HistoryItemsReturned);
        		$("#loader_text").text("Loaded history file " + HistoryItemsReturned + "/" + (PositionHistorySize-1));
			if (HistoryItemsReturned == PositionHistorySize) {
				end_load_history();
			}
                })

                .fail(function(jqxhr, status, error) {
			//Doesn't matter if it failed, we'll just be missing a data point
			HistoryItemsReturned++;
			if (HistoryItemsReturned == PositionHistorySize) {
				end_load_history();
			}
                });
}

function end_load_history() {
        $("#loader").addClass("hidden");

        console.log("Done loading history");

        if (PositionHistoryBuffer.length > 0) {
                var now, last=0;

                // Sort history by timestamp
                console.log("Sorting history");
                PositionHistoryBuffer.sort(function(x,y) { return (x.now - y.now); });

                // Process history
                for (var h = 0; h < PositionHistoryBuffer.length; ++h) {
                        now = PositionHistoryBuffer[h].now;
                        console.log("Applying history " + (h + 1) + "/" + PositionHistoryBuffer.length + " at: " + now);
                        processReceiverUpdate(PositionHistoryBuffer[h]);

                        // update track
                        console.log("Updating tracks at: " + now);
                        for (var i = 0; i < PlanesOrdered.length; ++i) {
                                var plane = PlanesOrdered[i];
                                plane.updateTrack((now - last) + 1);
                        }

                        last = now;
                }

                // Final pass to update all planes to their latest state
                console.log("Final history cleanup pass");
                for (var i = 0; i < PlanesOrdered.length; ++i) {
                        var plane = PlanesOrdered[i];
                        plane.updateTick(now);
                }

                LastReceiverTimestamp = last;
        }

        PositionHistoryBuffer = null;

        console.log("Completing init");

        refreshTableInfo();
        refreshSelected();
        refreshHighlighted();
        reaper();

        // Setup our timer to poll from the server.
	if (localStorage['refreshSpeed'] === 'slow') {
		RefreshInterval = SlowRefreshInterval;
	} else if (localStorage['refreshSpeed'] === 'med') {
		RefreshInterval = MedRefreshInterval;
	} else if (localStorage['refreshSpeed'] === 'fast') {
		RefreshInterval = FastRefreshInterval;
	}
	clearInterval(refRefresh);
        refRefresh = window.setInterval(fetchData, RefreshInterval);
        window.setInterval(reaper, ReaperInterval);

        // And kick off one refresh immediately.
        fetchData();

}

// Make a LineString with 'points'-number points
// that is a closed circle on the sphere such that the
// great circle distance from 'center' to each point is
// 'radius' meters
function make_geodesic_circle(center, radius, points) {
        var angularDistance = radius / 6378137.0;
        var lon1 = center[0] * Math.PI / 180.0;
        var lat1 = center[1] * Math.PI / 180.0;
        var geom = new ol.geom.LineString();
        for (var i = 0; i <= points; ++i) {
                var bearing = i * 2 * Math.PI / points;

                var lat2 = Math.asin( Math.sin(lat1)*Math.cos(angularDistance) +
                                      Math.cos(lat1)*Math.sin(angularDistance)*Math.cos(bearing) );
                var lon2 = lon1 + Math.atan2(Math.sin(bearing)*Math.sin(angularDistance)*Math.cos(lat1),
                                             Math.cos(angularDistance)-Math.sin(lat1)*Math.sin(lat2));

                lat2 = lat2 * 180.0 / Math.PI;
                lon2 = lon2 * 180.0 / Math.PI;
                geom.appendCoordinate([lon2, lat2]);
        }
        return geom;
}

// Initalizes the map and starts up our timers to call various functions
function initialize_map() {
        // Load stored map settings if present
        CenterLat = Number(localStorage['CenterLat']) || DefaultCenterLat;
        CenterLon = Number(localStorage['CenterLon']) || DefaultCenterLon;
        ZoomLvl = Number(localStorage['ZoomLvl']) || DefaultZoomLvl;
        MapType = localStorage['MapType'];

        // This gets set to a sane default, above, so we can use it in the 'or'.
        maxRangeRing = Number(localStorage['maxRangeRing']) || maxRangeRing;
        maxRangeSelect(maxRangeRing);

	RefreshIntervalWord = localStorage['refreshSpeed'] || DefaultRefreshIntervalWord;
	refreshSpeedSelect(RefreshIntervalWord);

        // Set SitePosition, initialize sorting
        if (SiteShow && (typeof SiteLat !==  'undefined') && (typeof SiteLon !==  'undefined')) {
	        SitePosition = [SiteLon, SiteLat];
                sortByDistance();
        } else {
	        SitePosition = null;
                PlaneRowTemplate.cells[9].style.display = 'none'; // hide distance column
                document.getElementById("distance").style.display = 'none'; // hide distance header
                sortByAltitude();
        }

        // Maybe hide flag info
        if (!ShowFlags) {
                PlaneRowTemplate.cells[1].style.display = 'none'; // hide flag column
                document.getElementById("flag").style.display = 'none'; // hide flag header
                document.getElementById("infoblock_country").style.display = 'none'; // hide country row
        }

        // Initialize OL3

        layers = createBaseLayers();

        var iconsLayer = new ol.layer.Vector({
                name: 'ac_positions',
                type: 'overlay',
                title: 'Aircraft positions',
                source: new ol.source.Vector({
                        features: PlaneIconFeatures,
                })
        });

        layers.push(new ol.layer.Group({
                title: 'Overlays',
                layers: [
                        new ol.layer.Vector({
                                name: 'site_pos',
                                type: 'overlay',
                                title: 'Site position',
                                source: new ol.source.Vector({
                                        features: StaticFeatures,
                                })
                        }),

                        new ol.layer.Vector({
                                name: 'range_rings',
                                type: 'overlay',
                                title: 'Range rings',
                                source: new ol.source.Vector({
                                        features: SiteCircleFeatures,
                                })
                        }),

                        new ol.layer.Vector({
                                name: 'ac_trail',
                                type: 'overlay',
                                title: 'Selected aircraft trail',
                                source: new ol.source.Vector({
                                        features: PlaneTrailFeatures,
                                })
                        }),

                        iconsLayer
                ]
        }));

        var foundType = false;
        var baseCount = 0;

        ol.control.LayerSwitcher.forEachRecursive(layers, function(lyr) {
                if (!lyr.get('name'))
                        return;

                if (lyr.get('type') === 'base') {
                    baseCount++;
                        if (MapType === lyr.get('name')) {
                                foundType = true;
                                lyr.setVisible(true);
                        } else {
                                lyr.setVisible(false);
                        }

                        lyr.on('change:visible', function(evt) {
                                if (evt.target.getVisible()) {
                                        MapType = localStorage['MapType'] = evt.target.get('name');
                                }
                        });
                } else if (lyr.get('type') === 'overlay') {
                        var visible = localStorage['layer_' + lyr.get('name')];
                        if (visible != undefined) {
                                // javascript, why must you taunt me with gratuitous type problems
                                lyr.setVisible(visible === "true");
                        }

                        lyr.on('change:visible', function(evt) {
                                localStorage['layer_' + evt.target.get('name')] = evt.target.getVisible();
                        });
                }
        })

        if (!foundType) {
                ol.control.LayerSwitcher.forEachRecursive(layers, function(lyr) {
                        if (foundType)
                                return;
                        if (lyr.get('type') === 'base') {
                                lyr.setVisible(true);
                                foundType = true;
                        }
                });
        }

        OLMap = new ol.Map({
                target: 'map_canvas',
                layers: layers,
                view: new ol.View({
                        center: ol.proj.fromLonLat([CenterLon, CenterLat]),
                        zoom: ZoomLvl,
			zoomFactor: 1.75
                }),
                controls: [new ol.control.Zoom(),
                           new ol.control.Rotate(),
                           new ol.control.Attribution({collapsed: true}),
                           new ol.control.ScaleLine({units: DisplayUnits})
                          ],
                loadTilesWhileAnimating: true,
                loadTilesWhileInteracting: true
        });

        if (baseCount > 1) {
            OLMap.addControl(new ol.control.LayerSwitcher());
        }

	// Listeners for newly created Map
        OLMap.getView().on('change:center', function(event) {
                var center = ol.proj.toLonLat(OLMap.getView().getCenter(), OLMap.getView().getProjection());
                localStorage['CenterLon'] = center[0]
                localStorage['CenterLat'] = center[1]
                if (FollowSelected) {
                        // On manual navigation, disable follow
                        var selected = Planes[SelectedPlane];
			if (typeof selected === 'undefined' ||
			    (Math.abs(center[0] - selected.position[0]) > 0.0001 &&
			     Math.abs(center[1] - selected.position[1]) > 0.0001)) {
                                FollowSelected = false;
                                refreshSelected();
                                refreshHighlighted();
                        }
                }
        });

	// If the map is moved, re-run the "onscreen" calcs and update the displays
        OLMap.on('moveend', function(event) {
		// Use this in case we're moving and zooming a lot, no need to waste CPU recalcualting.
                clearInterval(refResolutionChange);
        	refResolutionChange = window.setInterval(rescanOnScreen, debounceTime);
        });
    
        OLMap.getView().on('change:resolution', function(event) {
                ZoomLvl = localStorage['ZoomLvl']  = OLMap.getView().getZoom();

		// This fires a bunch of times when we zoom, so instead of doing this RIGHT NOW, delay debounceTime and do it once
                clearInterval(refResolutionChange);
        	refResolutionChange = window.setInterval(rescanOnScreen, debounceTime);
        });

        OLMap.on(['click', 'dblclick'], function(evt) {
                var hex = evt.map.forEachFeatureAtPixel(evt.pixel,
                                                        function(feature, layer) {
                                                                return feature.hex;
                                                        },
                                                        null,
                                                        function(layer) {
                                                                return (layer === iconsLayer);
                                                        },
                                                        null);
                if (hex) {
                        selectPlaneByHex(hex, (evt.type === 'dblclick'));
                        adjustSelectedInfoBlockPosition();
                        evt.stopPropagation();
                } else {
                        deselectAllPlanes();
                        evt.stopPropagation();
                }
        });


    // show the hover box
    OLMap.on('pointermove', function(evt) {
        var hex = evt.map.forEachFeatureAtPixel(evt.pixel,
            function(feature, layer) {
                    return feature.hex;
            },
            null,
            function(layer) {
                    return (layer === iconsLayer);
            },
            null
        );

        if (hex) {
            highlightPlaneByHex(hex);
        } else {
            removeHighlight();
        }

    })

    // handle the layer settings pane checkboxes
	OLMap.once('postrender', function(e) {
		toggleLayer('#nexrad_checkbox', 'nexrad');
		toggleLayer('#sitepos_checkbox', 'site_pos');
		toggleLayer('#rangerings_checkbox', 'range_rings');
		toggleLayer('#actrail_checkbox', 'ac_trail');
		toggleLayer('#acpositions_checkbox', 'ac_positions');
	});

	// Add home marker if requested
	if (SitePosition) {
                var markerStyle = new ol.style.Style({
                        image: new ol.style.Circle({
                                radius: 7,
                                snapToPixel: false,
                                fill: new ol.style.Fill({color: 'black'}),
                                stroke: new ol.style.Stroke({
                                        color: 'white', width: 2
                                })
                        })
                });

                var feature = new ol.Feature(new ol.geom.Point(ol.proj.fromLonLat(SitePosition)));
                feature.setStyle(markerStyle);
                StaticFeatures.push(feature);
        
                if (SiteCircles) {
                    createSiteCircleFeatures();
                }
	}

        // Add terrain-limit rings. To enable this:
        //
        //  create a panorama for your receiver location on heywhatsthat.com
        //
        //  note the "view" value from the URL at the top of the panorama
        //    i.e. the XXXX in http://www.heywhatsthat.com/?view=XXXX
        //
        // fetch a json file from the API for the altitudes you want to see:
        //
        //  wget -O /usr/share/dump1090-mutability/html/upintheair.json \
        //    'http://www.heywhatsthat.com/api/upintheair.json?id=XXXX&refraction=0.25&alts=3048,9144'
        //
        // NB: altitudes are in _meters_, you can specify a list of altitudes

        // kick off an ajax request that will add the rings when it's done
        var request = $.ajax({ url: 'upintheair.json',
                               timeout: 5000,
                               cache: true,
                               dataType: 'json' });
        request.done(function(data) {
                var ringStyle = new ol.style.Style({
                        fill: null,
                        stroke: new ol.style.Stroke({
                                color: '#000000',
                                width: 1
                        })
                });

                for (var i = 0; i < data.rings.length; ++i) {
                        var geom = new ol.geom.LineString();
                        var points = data.rings[i].points;
                        if (points.length > 0) {
                                for (var j = 0; j < points.length; ++j) {
                                        geom.appendCoordinate([ points[j][1], points[j][0] ]);
                                }
                                geom.appendCoordinate([ points[0][1], points[0][0] ]);
                                geom.transform('EPSG:4326', 'EPSG:3857');

                                var feature = new ol.Feature(geom);
                                feature.setStyle(ringStyle);
                                StaticFeatures.push(feature);
                        }
                }
        });

        request.fail(function(jqxhr, status, error) {
                // no rings available, do nothing
        });
}

function rescanOnScreen() {
    clearInterval(refResolutionChange);

    // Grab the canvas size (and calculate its extent), then iterate over plane list and re-calcualte which are in view
    var mapCanvas = $('#map_canvas');
    var mapExtent = getExtent(0, 0, mapCanvas.width(), mapCanvas.height());
    for (var i = 0; i < PlanesOrdered.length; ++i) {
        var local_icao = PlanesOrdered[i].icao;
        Planes[local_icao].updateMarker(false);
        Planes[local_icao].onscreen = false;
        PlanesOrdered[i].onscreen = false;
        if (PlanesOrdered[i].marker) {
            var markerCoordinates = PlanesOrdered[i].marker.getGeometry().getCoordinates();
            var markerPosition = OLMap.getPixelFromCoordinate(markerCoordinates);
            if (isPointInsideExtent(markerPosition[0], markerPosition[1], mapExtent)) {
                PlanesOrdered[i].onscreen = true;
                Planes[local_icao].onscreen = true;
            }
        }
    }
    // Refresh the display, too
    refreshTableInfo();
    refreshSelected();
    refreshHighlighted();
}

function createSiteCircleFeatures() {
    if (! SiteCircles) { return; }

    SiteCircleFeatures.clear();

    var circleStyle = function(distance) {
    	return new ol.style.Style({
            fill: null,
            stroke: new ol.style.Stroke({
                    color: '#000000',
                    width: 1
            }),
            text: new ol.style.Text({
            	font: '11px Helvetica Neue, sans-serif',
            	fill: new ol.style.Fill({ color: '#000' }),
				offsetY: -8,
				text: format_distance_long(distance, DisplayUnits, 0)

			})
		});
    };
    var circleStyleColor = function(distance, circleColor) {
        return new ol.style.Style({
            fill: null,
            stroke: new ol.style.Stroke({
                    color: circleColor,
                    width: 2
            }),
            text: new ol.style.Text({
                font: '11px Helvetica Neue, sans-serif',
                fill: new ol.style.Fill({ color: '#000' }),
                                offsetY: -8,
                                text: format_distance_long(distance, DisplayUnits, 0)

                        })
                });
    };

    var conversionFactor;
    var SCInterval = SiteCirclesInterval;
    if (DisplayUnits === "nautical") {
        conversionFactor = 1852.0;    // nm
    } else if (DisplayUnits === "imperial") {
        conversionFactor = 1609.0;    // mi
    } else {
	// This SHOULD only be metric, but we'll also use it as a fallback/default 
    	conversionFactor = 1000.0;    // km
    }

    //  We start at SiteCirclesInterval, and 1000 is here for sanity
    for (var i=SCInterval; i < 1000; i += SCInterval) {

            // Stop drawing afer we've hit max.
            if (i > maxRangeRing) { break; }

            var distance = i * conversionFactor;
            var circle = make_geodesic_circle(SitePosition, distance, 360);
            circle.transform('EPSG:4326', 'EPSG:3857');
            var feature = new ol.Feature(circle);

            // 2nd-to-last is Orange, last is red
            // otherwise alternate black (multiples of 100) and blue
            if ((i+SCInterval) === maxRangeRing) {
                feature.setStyle(circleStyleColor(distance, "#EE9911"));
            } else if (i === maxRangeRing) {
                feature.setStyle(circleStyleColor(distance, "#EE1111"));
            } else if ((parseInt(i / 100) * 100) !== i) {
                feature.setStyle(circleStyleColor(distance, "#1111EE"));
            } else {
                feature.setStyle(circleStyle(distance));
            }
            // StaticFeatures.push(feature);
            SiteCircleFeatures.push(feature);
    }
}

// This looks for planes to reap out of the master Planes variable
function reaper() {
        //console.log("Reaping started..");

        // Look for planes where we have seen no messages for >600 seconds
        var newPlanes = [];
        for (var i = 0; i < PlanesOrdered.length; ++i) {
                var plane = PlanesOrdered[i];
                if (plane.seen > 600) {
                        // Reap it.                                
                        plane.tr.parentNode.removeChild(plane.tr);
                        plane.tr = null;
                        delete Planes[plane.icao];
                        plane.destroy();
                } else {
                        // Keep it.
                        newPlanes.push(plane);
                }
        };

        PlanesOrdered = newPlanes;
        refreshTableInfo();
        refreshSelected();
        refreshHighlighted();
}

// Page Title update function
function refreshPageTitle() {
        if (!PlaneCountInTitle && !MessageRateInTitle) {
                document.title = PageName;
                return;
        }

        var subtitle = "";

        if (PlaneCountInTitle) {
                subtitle += TrackedAircraftPositions + '/' + TrackedAircraft;
        }

        if (MessageRateInTitle) {
                if (subtitle) subtitle += ' | ';
                subtitle += MessageRate.toFixed(1) + '/s';
        }

        document.title = PageName + ' - ' + subtitle;
}

function updateRefreshRate() {
        var rrTail = "s";
        var rrValue = StaleReceiverCount ? (StaleRefreshInterval/1000).toFixed(1) : (RefreshInterval/1000).toFixed(1);

        if (BGTrigger) {
                rrValue = (BGRefreshInterval/1000).toFixed(1);
                rrTail += " <font color=purple><b>[BG]</b></font>";
        }
        if (StaleReceiverCount > 2) {
                $('#refresh_rate').html("<font color=red><b>" + rrValue + "</b></font>" + rrTail);
        } else {
                $('#refresh_rate').html(rrValue + rrTail);
        }
}

// Refresh the detail window about the plane
function refreshSelected() {
        if (MessageCountHistory.length > 1) {
                var message_time_delta = MessageCountHistory[MessageCountHistory.length-1].time - MessageCountHistory[0].time;
                var message_count_delta = MessageCountHistory[MessageCountHistory.length-1].messages - MessageCountHistory[0].messages;
                if (message_time_delta > 0)
                        MessageRate = message_count_delta / message_time_delta;
        } else {
                MessageRate = null;
        }

	refreshPageTitle();
       
        var selected = false;
	if (typeof SelectedPlane !== 'undefined' && SelectedPlane != "ICAO" && SelectedPlane != null) {
    	        selected = Planes[SelectedPlane];
        }

	updateRefreshRate();
        
        $('#dump1090_infoblock').css('display','block');
	var dumpversiontext = Dump1090Version;
        $('#dump1090_version').text(dumpversiontext);
	if (OffscreenAircraft > 0) {
		var ac_text = TrackedAircraft + " (" + VisibleAircraft + " vis)";
        	$('#dump1090_total_ac').text(ac_text);
	} else {
        	$('#dump1090_total_ac').text(TrackedAircraft);
	}
        $('#dump1090_total_ac_positions').text(TrackedAircraftPositions);
        $('#dump1090_total_history').text(TrackedHistorySize);
        $('#dump1090_total_planes').text(TotalPlaneList);

        if (MessageRate !== null) {
                $('#dump1090_message_rate').text(MessageRate.toFixed(1));
        } else {
                $('#dump1090_message_rate').text("n/a");
        }

        setSelectedInfoBlockVisibility();

        if (!selected) {
                return;
        }
      
        if (selected.flight !== null && selected.flight !== "") {
                $('#selected_callsign').text(selected.flight);
        } else {
                $('#selected_callsign').text('n/a');
        }
        $('#selected_flightaware_link').html(getFlightAwareModeSLink(selected.icao, selected.flight, "Visit Flight Page"));

        if (selected.registration !== null) {
                $('#selected_registration').text(selected.registration);
        } else {
                $('#selected_registration').text("n/a");
        }

        if (selected.icaotype !== null) {
                $('#selected_icaotype').text(selected.icaotype);
        } else {
                $('#selected_icaotype').text("n/a");
        }

        // Not using this logic for the redesigned info panel at the time, but leaving it in  if/when adding it back
        // var emerg = document.getElementById('selected_emergency');
        // if (selected.squawk in SpecialSquawks) {
        //         emerg.className = SpecialSquawks[selected.squawk].cssClass;
        //         emerg.textContent = NBSP + 'Squawking: ' + SpecialSquawks[selected.squawk].text + NBSP ;
        // } else {
        //         emerg.className = 'hidden';
        // }

	$("#selected_altitude").text(format_altitude_long(selected.altitude, selected.vert_rate, DisplayUnits));
	$('#selected_onground').text(format_onground(selected.altitude));

        if (selected.squawk === null || selected.squawk === '0000') {
                $('#selected_squawk').text('n/a');
        } else {
                $('#selected_squawk').text(selected.squawk);
        }
	
	$('#selected_speed').text(format_speed_long(selected.gs, DisplayUnits));
	$('#selected_ias').text(format_speed_long(selected.ias, DisplayUnits));
	$('#selected_tas').text(format_speed_long(selected.tas, DisplayUnits));
	$('#selected_vertical_rate').text(format_vert_rate_long(selected.baro_rate, DisplayUnits));
	$('#selected_vertical_rate_geo').text(format_vert_rate_long(selected.geom_rate, DisplayUnits));
        $('#selected_icao').text(selected.icao.toUpperCase());
        $('#airframes_post_icao').attr('value',selected.icao);
	$('#selected_track').text(format_track_long(selected.track));

        if (selected.seen <= 1) {
                $('#selected_seen').text('now');
        } else {
                $('#selected_seen').text(selected.seen.toFixed(1) + 's');
        }

        $('#selected_country').text(selected.icaorange.country);
        if (ShowFlags && selected.icaorange.flag_image !== null) {
                $('#selected_flag').removeClass('hidden');
                $('#selected_flag img').attr('src', FlagPath + selected.icaorange.flag_image);
                $('#selected_flag img').attr('title', selected.icaorange.country);
        } else {
                $('#selected_flag').addClass('hidden');
        }

	if (selected.position === null) {
                $('#selected_position').text('n/a');
                $('#selected_follow').addClass('hidden');
        } else {
                
                if (selected.seen_pos > stalePos) {
                        $('#selected_position').text(format_latlng(selected.position) + " (" + selected.seen_pos.toFixed(0) + "s old)");
                } else {
                        $('#selected_position').text(format_latlng(selected.position));
		}
				
                $('#selected_follow').removeClass('hidden');
                if (FollowSelected) {
                        $('#selected_follow').css('font-weight', 'bold');
                        OLMap.getView().setCenter(ol.proj.fromLonLat(selected.position));
                } else {
                        $('#selected_follow').css('font-weight', 'normal');
                }
	}

	var sel_DS = format_data_source(selected.getDataSource());
	$('#selected_source').text(sel_DS);

	$('#selected_category').text(selected.category ? selected.category : "n/a");
        $('#selected_sitedist').text(format_distance_long(selected.sitedist, DisplayUnits));
        $('#selected_rssi').text(selected.rssi.toFixed(1) + ' dBFS');
        $('#selected_message_count').text(selected.messages);
	$('#selected_photo_link').html(getFlightAwarePhotoLink(selected.registration));
	$('#selected_altitude_geom').text(format_altitude_long(selected.alt_geom, selected.geom_rate, DisplayUnits));
        $('#selected_mag_heading').text(format_track_long(selected.mag_heading));
        $('#selected_true_heading').text(format_track_long(selected.true_heading));
        $('#selected_ias').text(format_speed_long(selected.ias, DisplayUnits));
        $('#selected_tas').text(format_speed_long(selected.tas, DisplayUnits));
        if (selected.mach == null) {
                $('#selected_mach').text('n/a');
        } else {
                $('#selected_mach').text(selected.mach.toFixed(3));
        }
        if (selected.roll == null) {
                $('#selected_roll').text('n/a');
        } else {
                $('#selected_roll').text(selected.roll.toFixed(1));
        }
        if (selected.track_rate == null) {
                $('#selected_trackrate').text('n/a');
        } else {
                $('#selected_trackrate').text(selected.track_rate.toFixed(2));
        }
        $('#selected_geom_rate').text(format_vert_rate_long(selected.geom_rate, DisplayUnits));
        if (selected.nav_qnh == null) {
                $('#selected_nav_qnh').text("n/a");
        } else {
                $('#selected_nav_qnh').text(selected.nav_qnh.toFixed(1) + " hPa");
        }
        $('#selected_nav_altitude').text(format_altitude_long(selected.nav_altitude, 0, DisplayUnits));
        $('#selected_nav_heading').text(format_track_long(selected.nav_heading));
        if (selected.nav_modes == null) {
                $('#selected_nav_modes').text("n/a");
        } else {
                $('#selected_nav_modes').text(selected.nav_modes.join());
	}
	if (selected.nic_baro == null) {
		$('#selected_nic_baro').text("n/a");
	} else {
		if (selected.nic_baro == 1) {
			$('#selected_nic_baro').text("cross-checked");
		} else {
			$('#selected_nic_baro').text("not cross-checked");
		}
	}

	$('#selected_nac_p').text(format_nac_p(selected.nac_p));
	$('#selected_nac_v').text(format_nac_v(selected.nac_v));
	if (selected.rc == null) {
		$('#selected_rc').text("n/a");
	} else if (selected.rc == 0) {
		$('#selected_rc').text("unknown");
	} else {
		$('#selected_rc').text(format_distance_short(selected.rc, DisplayUnits));
	}

	if (selected.sil == null || selected.sil_type == null) {
		$('#selected_sil').text("n/a");
	} else {
		var sampleRate = "";
		var silDesc = "";
		if (selected.sil_type == "perhour") {
			sampleRate = " per flight hour";
		} else if (selected.sil_type == "persample") {
			sampleRate = " per sample";
		}
			
		switch (selected.sil) {
			case 0:
				silDesc = "&gt; 1×10<sup>-3</sup>";
				break;
			case 1:
				silDesc = "≤ 1×10<sup>-3</sup>";
				break;
			case 2:
				silDesc = "≤ 1×10<sup>-5</sup>";
				break;
			case 3:
				silDesc = "≤ 1×10<sup>-7</sup>";
				break;
			default:
				silDesc = "n/a";
				sampleRate = "";
				break;
		}
		$('#selected_sil').html(silDesc + sampleRate);
	}

        if (selected.version == null) {
                $('#selected_version').text('none');
        } else if (selected.version == 0) {
                $('#selected_version').text('v0 (DO-260)');
        } else if (selected.version == 1) {
                $('#selected_version').text('v1 (DO-260A)');
        } else if (selected.version == 2) {
                $('#selected_version').text('v2 (DO-260B)');
        } else {
                $('#selected_version').text('v' + selected.version);
        }

        }

function refreshHighlighted() {
	// this is following nearly identical logic, etc, as the refreshSelected function, but doing less junk for the highlighted pane
	var highlighted = false;

	if (typeof HighlightedPlane !== 'undefined' && HighlightedPlane !== null) {
		highlighted = Planes[HighlightedPlane];
	}

	// no highlighted plane
	if (!highlighted) {
		$('#highlighted_infoblock').hide();
		return;
	}

	$('#highlighted_infoblock').show();

	// Get info box position and size
	var infoBox = $('#highlighted_infoblock');
	var infoBoxPosition = infoBox.position();
	if (typeof infoBoxOriginalPosition.top === 'undefined') {
		infoBoxOriginalPosition.top = infoBoxPosition.top;
		infoBoxOriginalPosition.left = infoBoxPosition.left;
	} else {
		infoBox.css("left", infoBoxOriginalPosition.left);
		infoBox.css("top", infoBoxOriginalPosition.top);
		infoBoxPosition = infoBox.position();
	}
	var infoBoxExtent = getExtent(infoBoxPosition.left, infoBoxPosition.top, infoBox.outerWidth(), infoBox.outerHeight());

	// Get map size
	var mapCanvas = $('#map_canvas');
	var mapExtent = getExtent(0, 0, mapCanvas.width(), mapCanvas.height());

	var marker = highlighted.marker;
	var markerCoordinates = highlighted.marker.getGeometry().getCoordinates();
	var markerPosition = OLMap.getPixelFromCoordinate(markerCoordinates);

	// Check for overlap
	//FIXME TODO: figure out this/remove this check
	if (isPointInsideExtent(markerPosition[0], markerPosition[1], infoBoxExtent) || true) {
		// Array of possible new positions for info box
		var candidatePositions = [];
		candidatePositions.push( { x: 40, y: 80 } );
		candidatePositions.push( { x: markerPosition[0] + 20, y: markerPosition[1] + 60 } );

		// Find new position
		for (var i = 0; i < candidatePositions.length; i++) {
			var candidatePosition = candidatePositions[i];
			var candidateExtent = getExtent(candidatePosition.x, candidatePosition.y, infoBox.outerWidth(), infoBox.outerHeight());

			if (!isPointInsideExtent(markerPosition[0],  markerPosition[1], candidateExtent) && isPointInsideExtent(candidatePosition.x, candidatePosition.y, mapExtent)) {
				// Found a new position that doesn't overlap marker - move box to that position
				infoBox.css("left", candidatePosition.x);
				infoBox.css("top", candidatePosition.y);
			}
		}
	}

	if (highlighted.flight !== null && highlighted.flight !== "") {
		$('#highlighted_callsign').text(highlighted.flight);
	} else {
		$('#highlighted_callsign').text('n/a');
	}

	if (highlighted.icaotype !== null) {
		$('#higlighted_icaotype').text(highlighted.icaotype);
	} else {
		$('#higlighted_icaotype').text("n/a");
	}

	var high_DS = format_data_source(highlighted.getDataSource());
	$('#highlighted_source').text(high_DS);

	if (highlighted.registration !== null) {
		$('#highlighted_registration').text(highlighted.registration);
	} else {
		$('#highlighted_registration').text("n/a");
	}

	$('#highlighted_speed').text(format_speed_long(highlighted.speed, DisplayUnits));

	$("#highlighted_altitude").text(format_altitude_long(highlighted.altitude, highlighted.vert_rate, DisplayUnits));

	$('#highlighted_icao').text(highlighted.icao.toUpperCase());

}

function refreshClock() {
	$('#clock_div').text(new Date().toLocaleString());
	var c = setTimeout(refreshClock, 500);
}

function removeHighlight() {
	HighlightedPlane = null;
	refreshHighlighted();
}

// Refreshes the larger table of all the planes
function refreshTableInfo() {
    var show_squawk_warning = false;

    TrackedAircraft = 0
    OffscreenAircraft = 0
    TrackedAircraftPositions = 0
    TrackedHistorySize = 0
    VisibleAircraft = 0;
    TotalPlaneList = 0;

    $(".altitudeUnit").text(get_unit_label("altitude", DisplayUnits));
    $(".speedUnit").text(get_unit_label("speed", DisplayUnits));
    $(".distanceUnit").text(get_unit_label("distance", DisplayUnits));
    $(".verticalRateUnit").text(get_unit_label("verticalRate", DisplayUnits));

    var rssi_sum = 0;
    var rssi_min = 0;
    var rssi_max = -9999;
    var valid_rssi_count = 0;

    for (var i = 0; i < PlanesOrdered.length; ++i) {
	var tableplane = PlanesOrdered[i];
	TrackedHistorySize += tableplane.history_size;
	TotalPlaneList++;

	if (tableplane.seen >= 58 || tableplane.isFiltered()) {
            tableplane.tr.className = "plane_table_row hidden";
        } else {
            TrackedAircraft++;
            var classes = "plane_table_row";
	    var seen_string = tableplane.seen.toFixed(0);
	    var posDot = "<font color=#BBBBBB>" + BULL + "</font>"

            if (tableplane.position !== null) {
	        // If we want to hide "off screen" aircraft, and if this aircraft is, in fact, off the screen, then add the 'hidden' class to this one
 	        if (hideOffscreenAircraft && !tableplane.onscreen) {
		    OffscreenAircraft++;
	            classes += " hidden";
	        }
		if (tableplane.seen_pos < 60) {
                    TrackedAircraftPositions++;
		}
		if (tableplane.seen_pos >= posYellow) {
		    if (tableplane.seen_pos >= posOrange) {
		        if (tableplane.seen_pos >= posRed) {
		            posDot = "<font color=red>" + BULL + "</font>"
		        } else {
		            posDot = "<font color=orange>" + BULL + "</font>"
		        }
		    } else {
		        posDot = "<font color=#BBBB00>" + BULL + "</font>"
                    }
		} else {
		        posDot = "<font color=green>" + BULL + "</font>"
                }
	    }
	    if (hideOffscreenAircraft && tableplane.onscreen) {
		VisibleAircraft++;
	    }

	    if (tableplane.getDataSource() === "adsb_icao") {
        	classes += " vPosition";
            } else if (tableplane.getDataSource() === "tisb_trackfile" || tableplane.getDataSource() === "tisb_icao" || tableplane.getDataSource() === "tisb_other") {
        	classes += " tisb";
            } else if (tableplane.getDataSource() === "mlat") {
        	classes += " mlat";
            } else {
        	classes += " other";
            }

            // >45 sec = red, >30 sec = orange, >15 sec = yellow
            if (tableplane.seen >= 15) {
              if (tableplane.seen >= 30) {
                if (tableplane.seen >= 45) {
                    seen_string = "<font color=red>" + tableplane.seen.toFixed(0) + "</font>";
                } else {
                    seen_string = "<font color=orange>" + tableplane.seen.toFixed(0) + "</font>";
                }
              } else {
                 seen_string = "<font color=#BBBB00>" + tableplane.seen.toFixed(0) + "</font>";
              }
            }
	    seen_string = seen_string + posDot;

	    // If we want US Military highlighting, AND this plane matches the isUSMil pattern, then mark it
            if (highlightUSMil && isUSMil.test(tableplane.icao)) {
		Planes[tableplane.icao].isUSMil = true;
                classes += " usmil";

		// Now we need to do some lame stuff and iterate (backwards) through the columns, adding borders.
		// Why backwards? Because we need to find the fist visible one (from the right) in order to apply the "_R" class to it
		// The first column is always shown (ICAO), so we always use the "_L" class on it
		// all the other columns get the generic "usmilcell" class.
		var first_vis = 0;
		tableplane.tr.cells[0].className = "icaoCodeColumn usmilcell_L";
		for (var c = 20; c > 0; c--) {
		    if (tableplane.tr.cells[c]) {
			// As soon as we hit the first visible one, use the _R style
			if (!first_vis) {
			    if ($(tableplane.tr.cells[c]).css('display') !== "none") {
				first_vis = 1;
		    		tableplane.tr.cells[c].className = " usmilcell_R";
			    }
			} else {
		    	    tableplane.tr.cells[c].className = " usmilcell";
			}
		    }
		}
	    }

	    // So we don't override the onclick-selected class
	    if (tableplane.icao == SelectedPlane) {
		if (highlightUSMil && Planes[SelectedPlane].isUSMil) {
		    classes += " selectedusmil";
		} else {
            	    classes += " selected";
		}
            }

            if (tableplane.squawk in SpecialSquawks) {
                classes = classes + " " + SpecialSquawks[tableplane.squawk].cssClass;
                show_squawk_warning = true;
	    }			                

            // ICAO doesn't change
            if (tableplane.flight) {
                tableplane.tr.cells[2].innerHTML = getFlightAwareModeSLink(tableplane.icao, tableplane.flight, tableplane.flight);
            } else {
                tableplane.tr.cells[2].innerHTML = "";
            }
            tableplane.tr.cells[3].textContent = (tableplane.registration !== null ? tableplane.registration : "");
            tableplane.tr.cells[4].textContent = (tableplane.icaotype !== null ? tableplane.icaotype : "");
            tableplane.tr.cells[5].textContent = (tableplane.squawk !== null ? tableplane.squawk : "");
            tableplane.tr.cells[6].innerHTML = format_altitude_brief(tableplane.altitude, tableplane.vert_rate, DisplayUnits);
            tableplane.tr.cells[7].textContent = format_speed_brief(tableplane.gs, DisplayUnits);
            tableplane.tr.cells[8].textContent = format_vert_rate_brief(tableplane.vert_rate, DisplayUnits);
            tableplane.tr.cells[9].textContent = format_distance_brief(tableplane.sitedist, DisplayUnits);
            tableplane.tr.cells[10].textContent = format_track_brief(tableplane.track);
            tableplane.tr.cells[11].textContent = tableplane.messages;
            tableplane.tr.cells[12].innerHTML = seen_string;
            tableplane.tr.cells[13].textContent = (tableplane.rssi !== null ? tableplane.rssi : "");
            tableplane.tr.cells[14].textContent = (tableplane.position !== null ? tableplane.position[1].toFixed(4) : "");
            tableplane.tr.cells[15].textContent = (tableplane.position !== null ? tableplane.position[0].toFixed(4) : "");
            tableplane.tr.cells[16].innerHTML = format_data_source(tableplane.getDataSource()).replace(/ /, "&nbsp");
            tableplane.tr.cells[17].innerHTML = getAirframesModeSLink(tableplane.icao);
            tableplane.tr.cells[18].innerHTML = getFlightAwareModeSLink(tableplane.icao, tableplane.flight);
            tableplane.tr.cells[19].innerHTML = getFlightAwarePhotoLink(tableplane.registration);
            tableplane.tr.className = classes;

            // Let's store min/max/avg RSSI...
	    //   -49 or less is generally "no RSSI", so ignore those
            var tp_rssi = tableplane.rssi;
            if (tp_rssi !== null && tp_rssi > -49) {
                valid_rssi_count++;
                rssi_sum += tp_rssi;
                if (tp_rssi < rssi_min) {
                        rssi_min = tp_rssi;
                } else if (tp_rssi > rssi_max) {
                        rssi_max = tp_rssi;
                }
            }
	}
    }

    if (!hideOffscreenAircraft)
	VisibleAircraft = TrackedAircraft;

    var rssi_avg = (rssi_sum / valid_rssi_count).toFixed(1);

    $('#rssi_values').text(rssi_max.toFixed(1) + " / " + rssi_avg + " / " + rssi_min.toFixed(1) + "  dBFS");

    if (show_squawk_warning) {
        $("#SpecialSquawkWarning").css('display','block');
    } else {
        $("#SpecialSquawkWarning").css('display','none');
    }

    if (TrackedAircraft && !VisibleAircraft) {
	$("#misc_text").text("No aircraft visible on map (try zooming out or moving it)");
    } else if (!TrackedAircraft) {
	$("#misc_text").text("No aircraft being tracked");
    } else {
	$("#misc_text").text("");
    }

    resortTable();
}

//
// ---- table sorting ----
//

function compareAlpha(xa,ya) {
        if (xa === ya)
                return 0;
        if (xa < ya)
                return -1;
        return 1;
}

function compareNumeric(xf,yf) {
        if (Math.abs(xf - yf) < 1e-9)
                return 0;

        return xf - yf;
}

function sortByICAO()     { sortBy('icao',    compareAlpha,   function(x) { return x.icao; }); }
function sortByFlight()   { sortBy('flight',  compareAlpha,   function(x) { return x.flight; }); }
function sortByRegistration()   { sortBy('registration',    compareAlpha,   function(x) { return x.registration; }); }
function sortByAircraftType()   { sortBy('icaotype',        compareAlpha,   function(x) { return x.icaotype; }); }
function sortBySquawk()   { sortBy('squawk',  compareAlpha,   function(x) { return x.squawk; }); }
function sortByAltitude() { sortBy('altitude',compareNumeric, function(x) { return (x.altitude == "ground" ? -1e9 : x.altitude); }); }
function sortBySpeed()    { sortBy('speed',   compareNumeric, function(x) { return x.gs; }); }
function sortByVerticalRate()   { sortBy('vert_rate',      compareNumeric, function(x) { return x.vert_rate; }); }
function sortByDistance() { sortBy('sitedist',compareNumeric, function(x) { return x.sitedist; }); }
function sortByTrack()    { sortBy('track',   compareNumeric, function(x) { return x.track; }); }
function sortByMsgs()     { sortBy('msgs',    compareNumeric, function(x) { return x.messages; }); }
function sortBySeen()     { sortBy('seen',    compareNumeric, function(x) { return x.seen; }); }
function sortByCountry()  { sortBy('country', compareAlpha,   function(x) { return x.icaorange.country; }); }
function sortByRssi()     { sortBy('rssi',    compareNumeric, function(x) { return x.rssi }); }
function sortByLatitude()   { sortBy('lat',   compareNumeric, function(x) { return (x.position !== null ? x.position[1] : null) }); }
function sortByLongitude()  { sortBy('lon',   compareNumeric, function(x) { return (x.position !== null ? x.position[0] : null) }); }
function sortByDataSource() { sortBy('data_source',     compareAlpha, function(x) { return x.getDataSource() } ); }

var sortId = '';
var sortCompare = null;
var sortExtract = null;
var sortAscending = true;

function sortFunction(x,y) {
        var xv = x._sort_value;
        var yv = y._sort_value;

        // always sort missing values at the end, regardless of
        // ascending/descending sort
        if (xv == null && yv == null) return x._sort_pos - y._sort_pos;
        if (xv == null) return 1;
        if (yv == null) return -1;

        var c = sortAscending ? sortCompare(xv,yv) : sortCompare(yv,xv);
        if (c !== 0) return c;

        return x._sort_pos - y._sort_pos;
}

function resortTable() {
        // number the existing rows so we can do a stable sort
        // regardless of whether sort() is stable or not.
        // Also extract the sort comparison value.
        for (var i = 0; i < PlanesOrdered.length; ++i) {
                PlanesOrdered[i]._sort_pos = i;
                PlanesOrdered[i]._sort_value = sortExtract(PlanesOrdered[i]);
        }

        PlanesOrdered.sort(sortFunction);
        
        var tbody = document.getElementById('tableinfo').tBodies[0];
        for (var i = 0; i < PlanesOrdered.length; ++i) {
                tbody.appendChild(PlanesOrdered[i].tr);
        }
}

function sortBy(id,sc,se) {
	if (id !== 'data_source') {
		$('#grouptype_checkbox').removeClass('settingsCheckboxChecked');
	} else {
		$('#grouptype_checkbox').addClass('settingsCheckboxChecked');
	}
        if (id === sortId) {
                sortAscending = !sortAscending;
                PlanesOrdered.reverse(); // this correctly flips the order of rows that compare equal
        } else {
                sortAscending = true;
        }

        sortId = id;
        sortCompare = sc;
        sortExtract = se;

        resortTable();
}

function selectPlaneByHex(hex,autofollow) {
        //console.log("select: " + hex);
	// If SelectedPlane has something in it, clear out the selected
	if (SelectedAllPlanes) {
		deselectAllPlanes();
	}

	if (SelectedPlane != null) {
		Planes[SelectedPlane].selected = false;
		Planes[SelectedPlane].clearLines();
		Planes[SelectedPlane].updateMarker();
                $(Planes[SelectedPlane].tr).removeClass("selected");
                $(Planes[SelectedPlane].tr).removeClass("selectedusmil");
		// scroll the infoblock back to the top for the next plane to be selected
		$('.infoblock-container').scrollTop(0);
	}

	// If we are clicking the same plane, we are deselecting it.
	// (unless it was a doubleclick..)
	if (SelectedPlane === hex && !autofollow) {
		hex = null;
	}

	if (hex !== null) {
		// Assign the new selected
		SelectedPlane = hex;
		Planes[SelectedPlane].selected = true;
		Planes[SelectedPlane].updateLines();
		Planes[SelectedPlane].updateMarker();
		if (highlightUSMil && Planes[SelectedPlane].isUSMil) {
		    $(Planes[SelectedPlane].tr).addClass("selectedusmil");
		} else {
		    $(Planes[SelectedPlane].tr).addClass("selected");
		}
	} else { 
		SelectedPlane = null;
	}

	if (SelectedPlane !== null && autofollow) {
		FollowSelected = true;
		if (OLMap.getView().getZoom() < 8)
			OLMap.getView().setZoom(8);
	} else {
		FollowSelected = false;
	} 

	refreshSelected();
	refreshHighlighted();
}

function highlightPlaneByHex(hex) {

	if (hex != null) {
		HighlightedPlane = hex;
	}
}

// loop through the planes and mark them as selected to show the paths for all planes
function selectAllPlanes() {
    HighlightedPlane = null;
	// if all planes are already selected, deselect them all
	if (SelectedAllPlanes) {
		deselectAllPlanes();
	} else {
		// If SelectedPlane has something in it, clear out the selected
		if (SelectedPlane != null) {
			Planes[SelectedPlane].selected = false;
			Planes[SelectedPlane].clearLines();
			Planes[SelectedPlane].updateMarker();
			$(Planes[SelectedPlane].tr).removeClass("selected");
		}

		SelectedPlane = null;
		SelectedAllPlanes = true;

		for(var key in Planes) {
			if (Planes[key].visible && !Planes[key].isFiltered()) {
				Planes[key].selected = true;
				Planes[key].updateLines();
				Planes[key].updateMarker();
			}
		}
	}

	$('#selectall_checkbox').addClass('settingsCheckboxChecked');

	refreshSelected();
	refreshHighlighted();
}

// on refreshes, try to find new planes and mark them as selected
function selectNewPlanes() {
	if (SelectedAllPlanes) {
		for (var key in Planes) {
			if (!Planes[key].visible || Planes[key].isFiltered()) {
				Planes[key].selected = false;
				Planes[key].clearLines();
				Planes[key].updateMarker();
			} else {
				if (Planes[key].selected !== true) {
					Planes[key].selected = true;
					Planes[key].updateLines();
					Planes[key].updateMarker();
				}
			}
		}
	}
}

// deselect all the planes
function deselectAllPlanes() {
	for(var key in Planes) {
		Planes[key].selected = false;
		Planes[key].clearLines();
		Planes[key].updateMarker();
		$(Planes[key].tr).removeClass("selected");
	}
	$('#selectall_checkbox').removeClass('settingsCheckboxChecked');
	SelectedPlane = null;
	SelectedAllPlanes = false;
	refreshSelected();
	refreshHighlighted();
}

function toggleFollowSelected() {
        FollowSelected = !FollowSelected;
        if (FollowSelected && OLMap.getView().getZoom() < 8)
                OLMap.getView().setZoom(8);
        refreshSelected();
}

function resetMap() {
        // Reset localStorage values and map settings
        localStorage['CenterLat'] = CenterLat = DefaultCenterLat;
        localStorage['CenterLon'] = CenterLon = DefaultCenterLon;
        localStorage['ZoomLvl']   = ZoomLvl = DefaultZoomLvl;

        // Set and refresh
        OLMap.getView().setZoom(ZoomLvl);
	OLMap.getView().setCenter(ol.proj.fromLonLat([CenterLon, CenterLat]));
	
	selectPlaneByHex(null,false);
}

function updateMapSize() {
    OLMap.updateSize();
}

function toggleSidebarVisibility(e) {
    e.preventDefault();
    $("#sidebar_container").toggle();
    $("#expand_sidebar_control").toggle();
    $("#toggle_sidebar_button").toggleClass("show_sidebar");
    $("#toggle_sidebar_button").toggleClass("hide_sidebar");
    updateMapSize();
}

function expandSidebar(e) {
    e.preventDefault();
    $("#map_container").hide()
    $("#toggle_sidebar_control").hide();
    $("#splitter").hide();
    $("#sudo_buttons").hide();
    $("#show_map_button").show();
    $("#min_col_button").hide();
    $("#med_col_button").hide();
    $("#max_col_button").hide();
    $("#sidebar_container").width("100%");
    setColumnVisibility();
    setSelectedInfoBlockVisibility();
    updateMapSize();
}

function showMap() {
    $("#map_container").show()
    $("#toggle_sidebar_control").show();
    $("#splitter").show();
    $("#sudo_buttons").show();
    $("#show_map_button").hide();
    $("#min_col_button").show();
    $("#med_col_button").show();
    $("#max_col_button").show();
    $("#sidebar_container").width("550px");
    setColumnVisibility();
    setSelectedInfoBlockVisibility();
    updateMapSize();    
}

function showMinCol() {
    var mapIsVisible = $("#map_container").is(":visible");
    var infoTable = $("#tableinfo");

    $("#sidebar_container").width("440px");
    showColumn(infoTable, "#registration", 0);
    showColumn(infoTable, "#aircraft_type", 0);
    showColumn(infoTable, "#vert_rate", 0);
    showColumn(infoTable, "#rssi", 0);
    showColumn(infoTable, "#lat", 0);
    showColumn(infoTable, "#lon", 0);
    showColumn(infoTable, "#msgs", 0);
    showColumn(infoTable, "#data_source", 0);
    showColumn(infoTable, "#airframes_mode_s_link", 0);
    showColumn(infoTable, "#flightaware_mode_s_link", 0);
    showColumn(infoTable, "#flightaware_photo_link", 0);
    if (OLMap !== null)
        updateMapSize();
}

function showMedCol() {
    var mapIsVisible = $("#map_container").is(":visible");
    var infoTable = $("#tableinfo");

    $("#sidebar_container").width("590px");
    showColumn(infoTable, "#registration", 1);
    showColumn(infoTable, "#aircraft_type", 1);
    showColumn(infoTable, "#vert_rate", 0);
    showColumn(infoTable, "#rssi", 1);
    showColumn(infoTable, "#lat", 0);
    showColumn(infoTable, "#lon", 0);
    showColumn(infoTable, "#msgs", 0);
    showColumn(infoTable, "#data_source", 0);
    showColumn(infoTable, "#airframes_mode_s_link", 0);
    showColumn(infoTable, "#flightaware_mode_s_link", 0);
    showColumn(infoTable, "#flightaware_photo_link", 0);
    if (OLMap !== null)
        updateMapSize();
}

function showMaxCol() {
    var mapIsVisible = $("#map_container").is(":visible");
    var infoTable = $("#tableinfo");

    $("#sidebar_container").width("770px");

    showColumn(infoTable, "#registration", 1);
    showColumn(infoTable, "#aircraft_type", 1);
    showColumn(infoTable, "#vert_rate", 0);
    showColumn(infoTable, "#rssi", 1);
    showColumn(infoTable, "#lat", 1);
    showColumn(infoTable, "#lon", 1);
    showColumn(infoTable, "#msgs", 1);
    showColumn(infoTable, "#data_source", 1);
    showColumn(infoTable, "#airframes_mode_s_link", 0);
    showColumn(infoTable, "#flightaware_mode_s_link", 0);
    showColumn(infoTable, "#flightaware_photo_link", 0);
    if (OLMap !== null)
        updateMapSize();
}

function pause60sec() {
        if (wasPaused !== 0) {
                $("#pause60").html('<span class="buttonText">Pause 60s</span>');
                wasPaused = 0;
                clearInterval(refRefresh);
                refRefresh = window.setInterval(fetchData, RefreshInterval);

                // $('#refresh_rate').html((RefreshInterval/1000).toFixed(1) + "s");
                updateRefreshRate();
        } else {
                $("#pause60").html('<span class="buttonText">RESUME</span>');
                wasPaused = 1;
                clearInterval(refRefresh);
                refRefresh = window.setInterval(fetchData, PausedRefreshInterval);

                $('#refresh_rate').html("<font color=orange><b>[Paused] " + (PausedRefreshInterval/1000).toFixed(1) + "s</b></font>");
        }
}

function showColumn(table, columnId, visible) {
    var index = $(columnId).index();
    if (index >= 0) {
        var cells = $(table).find("td:nth-child(" + (index + 1).toString() + ")");
        if (visible) {
            cells.show();
        } else {
            cells.hide();
        }
    }
}

function setColumnVisibility() {
    var mapIsVisible = $("#map_container").is(":visible");
    var infoTable = $("#tableinfo");

    showColumn(infoTable, "#registration", !mapIsVisible);
    showColumn(infoTable, "#aircraft_type", !mapIsVisible);   
    showColumn(infoTable, "#vert_rate", !mapIsVisible);
    showColumn(infoTable, "#rssi", !mapIsVisible);
    showColumn(infoTable, "#lat", !mapIsVisible);
    showColumn(infoTable, "#lon", !mapIsVisible);
    showColumn(infoTable, "#data_source", !mapIsVisible);
    showColumn(infoTable, "#airframes_mode_s_link", !mapIsVisible);
    showColumn(infoTable, "#flightaware_mode_s_link", !mapIsVisible);
    showColumn(infoTable, "#flightaware_photo_link", !mapIsVisible);

    if (mapIsVisible)
        showMedCol();
}

function setSelectedInfoBlockVisibility() {
    var mapIsVisible = $("#map_container").is(":visible");
    var planeSelected = (typeof SelectedPlane !== 'undefined' && SelectedPlane != null && SelectedPlane != "ICAO");

    if (planeSelected && mapIsVisible) {
        $('#selected_infoblock').show();
	$('#sidebar_canvas').css('margin-bottom', $('#selected_infoblock').height() + 'px');
    } else {
        $('#selected_infoblock').hide();
	$('#sidebar_canvas').css('margin-bottom', 0);
    }
}

// Reposition selected plane info box if it overlaps plane marker
function adjustSelectedInfoBlockPosition() {
    if (typeof Planes === 'undefined' || typeof SelectedPlane === 'undefined' || Planes === null) {
        return;
    }

    var selectedPlane = Planes[SelectedPlane];

    if (selectedPlane === undefined || selectedPlane === null || selectedPlane.marker === undefined || selectedPlane.marker === null) {
        return;
    }

    try {
        // Get marker position
        var marker = selectedPlane.marker;
        var markerCoordinates = selectedPlane.marker.getGeometry().getCoordinates();
	var markerPosition = OLMap.getPixelFromCoordinate(markerCoordinates);
		
        // Get map size
        var mapCanvas = $('#map_canvas');
        var mapExtent = getExtent(0, 0, mapCanvas.width(), mapCanvas.height());

        // Check for overlap
        if (isPointInsideExtent(markerPosition[0], markerPosition[1], infoBoxExtent)) {
            // Array of possible new positions for info box
            var candidatePositions = [];
            candidatePositions.push( { x: 40, y: 60 } );
            candidatePositions.push( { x: 40, y: markerPosition[1] + 80 } );

            // Find new position
            for (var i = 0; i < candidatePositions.length; i++) {
                var candidatePosition = candidatePositions[i];
                var candidateExtent = getExtent(candidatePosition.x, candidatePosition.y, infoBox.outerWidth(), infoBox.outerHeight());

                if (!isPointInsideExtent(markerPosition[0],  markerPosition[1], candidateExtent) && isPointInsideExtent(candidatePosition.x, candidatePosition.y, mapExtent)) {
                    // Found a new position that doesn't overlap marker - move box to that position
                    infoBox.css("left", candidatePosition.x);
                    infoBox.css("top", candidatePosition.y);
                    return;
                }
            }
        }
    } 
    catch(e) { }
}

function getExtent(x, y, width, height) {
    return {
        xMin: x,
        yMin: y,
        xMax: x + width - 1,
        yMax: y + height - 1,
    };
}

function isPointInsideExtent(x, y, extent) {
    return x >= extent.xMin && x <= extent.xMax && y >= extent.yMin && y <= extent.yMax;
}

function initializeUnitsSelector() {
    // Get display unit preferences from local storage
    if (!localStorage.getItem('displayUnits')) {
        localStorage['displayUnits'] = "nautical";
    }
    var displayUnits = localStorage['displayUnits'];
    DisplayUnits = displayUnits;

    setAltitudeLegend(displayUnits);

    // Initialize drop-down
    var unitsSelector = $("#units_selector");
    unitsSelector.val(displayUnits);
    unitsSelector.on("change", onDisplayUnitsChanged);
}

function onDisplayUnitsChanged(e) {
    var displayUnits = e.target.value;
    // Save display units to local storage
    localStorage['displayUnits'] = displayUnits;
    DisplayUnits = displayUnits;

    setAltitudeLegend(displayUnits);

    // Update filters
    updatePlaneFilter();

    // Refresh data
    refreshTableInfo();
    refreshSelected();
    refreshHighlighted();

    // Redraw range rings
    if (SitePosition !== null && SitePosition !== undefined && SiteCircles) {
        createSiteCircleFeatures();
    }

    // Reset map scale line units
    OLMap.getControls().forEach(function(control) {
        if (control instanceof ol.control.ScaleLine) {
            control.setUnits(displayUnits);
        }
    });
}

function setAltitudeLegend(units) {
    if (units === 'metric') {
        $('#altitude_chart_button').addClass('altitudeMeters');
    } else {
        $('#altitude_chart_button').removeClass('altitudeMeters');
    }
}

function onFilterByAltitude(e) {
    e.preventDefault();
    updatePlaneFilter();
    refreshTableInfo();

    var selectedPlane = Planes[SelectedPlane];
    if (selectedPlane !== undefined && selectedPlane !== null && selectedPlane.isFiltered()) {
        SelectedPlane = null;
        selectedPlane.selected = false;
        selectedPlane.clearLines();
        selectedPlane.updateMarker();         
        refreshSelected();
        refreshHighlighted();
    }
}

function maxRangeSelect(range) {
        if (typeof localStorage['maxRangeRing'] === 'undefined') {
                localStorage['maxRangeRing'] = maxRangeRing;
        }
        maxRangeRing = range;
        if (range === 500) {
                $('#range300_checkbox').removeClass('settingsCheckboxChecked');
                $('#range400_checkbox').removeClass('settingsCheckboxChecked');
                $('#range500_checkbox').addClass('settingsCheckboxChecked');
        } else if (range === 400) {
                $('#range300_checkbox').removeClass('settingsCheckboxChecked');
                $('#range400_checkbox').addClass('settingsCheckboxChecked');
                $('#range500_checkbox').removeClass('settingsCheckboxChecked');
        } else if (range === 300) {
                $('#range300_checkbox').addClass('settingsCheckboxChecked');
                $('#range400_checkbox').removeClass('settingsCheckboxChecked');
                $('#range500_checkbox').removeClass('settingsCheckboxChecked');
        }
        localStorage['maxRangeRing'] = maxRangeRing;
        if (!maxRangeInit) { createSiteCircleFeatures(); }
        maxRangeInit = 0;
}

// We'll pass this 'fast', 'med', or 'slow' just because
function refreshSpeedSelect(refresh_speed) {
	// If this is unset, fall back to default (fast)
        if (typeof localStorage['refreshSpeed'] === 'undefined') {
                localStorage['refreshSpeed'] = 'fast';
        }
	if (refresh_speed === 'slow') {
		$('#refresh_fast_checkbox').removeClass('settingsCheckboxChecked');
		$('#refresh_med_checkbox').removeClass('settingsCheckboxChecked');
		$('#refresh_slow_checkbox').addClass('settingsCheckboxChecked');
		RefreshInterval = SlowRefreshInterval;
	} else if (refresh_speed === 'med') {
		$('#refresh_fast_checkbox').removeClass('settingsCheckboxChecked');
		$('#refresh_med_checkbox').addClass('settingsCheckboxChecked');
		$('#refresh_slow_checkbox').removeClass('settingsCheckboxChecked');
		RefreshInterval = MedRefreshInterval;
	} else if (refresh_speed === 'fast') {
		$('#refresh_fast_checkbox').addClass('settingsCheckboxChecked');
		$('#refresh_med_checkbox').removeClass('settingsCheckboxChecked');
		$('#refresh_slow_checkbox').removeClass('settingsCheckboxChecked');
		RefreshInterval = FastRefreshInterval;
	} 
	localStorage['refreshSpeed'] = refresh_speed;
	clearInterval(refRefresh);
	refRefresh = window.setInterval(fetchData, RefreshInterval);
	updateRefreshRate();
}

function toggleBackgrounding(switchToggle) {
        if (typeof localStorage['Backgrounding'] === 'undefined') {
                localStorage['Backgrounding'] = 'enabled';
        }
        var Backgrounding = localStorage['Backgrounding'];
        if (switchToggle === true) {
                Backgrounding = (Backgrounding === 'disabled') ? 'enabled' : 'disabled';
        }
        if (Backgrounding === 'disabled') {
                $('#nobg_checkbox').addClass('settingsCheckboxChecked');
                enableBG = 0;
        } else {
                $('#nobg_checkbox').removeClass('settingsCheckboxChecked');
                enableBG = 1;
        }
        localStorage['Backgrounding'] = Backgrounding;
}

function toggleHighlightUSMil(switchToggle) {
        if (typeof localStorage['HighlightUSMil'] === 'undefined') {
                localStorage['HighlightUSMil'] = 'enabled';
        }
        var HighlightUSMil = localStorage['HighlightUSMil'];
        if (switchToggle === true) {
                HighlightUSMil = (HighlightUSMil === 'disabled') ? 'enabled' : 'disabled';
        }
        if (HighlightUSMil === 'enabled') {
                $('#highlight_us_mil_checkbox').addClass('settingsCheckboxChecked');
                highlightUSMil = 1;
        } else {
                $('#highlight_us_mil_checkbox').removeClass('settingsCheckboxChecked');
                highlightUSMil = 0;
        }
        localStorage['HighlightUSMil'] = HighlightUSMil;
}

function toggleHideOffscreen(switchToggle) {
        if (typeof localStorage['HideOffscreen'] === 'undefined') {
                localStorage['HideOffscreen'] = 'show';
        }
        var HideOffscreen = localStorage['HideOffscreen'];
        if (switchToggle === true) {
                HideOffscreen = (HideOffscreen === 'show') ? 'hide' : 'show';
        }
        if (HideOffscreen === 'hide') {
                $('#hide_offscreen_checkbox').addClass('settingsCheckboxChecked');
                hideOffscreenAircraft = true;
        } else {
                $('#hide_offscreen_checkbox').removeClass('settingsCheckboxChecked');
                hideOffscreenAircraft = false;
        }
        localStorage['HideOffscreen'] = HideOffscreen;
}

function toggleAltitudeFilter(switchToggle) {
        if (typeof localStorage['AltitudeFilter'] === 'undefined') {
                localStorage['AltitudeFilter'] = 'shown';
        }
        var AltitudeFilter = localStorage['AltitudeFilter'];
        if (switchToggle === true) {
                AltitudeFilter = (AltitudeFilter === 'hidden') ? 'shown' : 'hidden';
        }
        if (AltitudeFilter === 'hidden') {
                $('#hide_alt_checkbox').addClass('settingsCheckboxChecked');
                $('#altitude_filter_form').hide();
        } else {
                $('#hide_alt_checkbox').removeClass('settingsCheckboxChecked');
                $('#altitude_filter_form').show();
        }
        localStorage['AltitudeFilter'] = AltitudeFilter;
}

function filterGroundVehicles(switchFilter) {
	if (typeof localStorage['groundVehicleFilter'] === 'undefined') {
		localStorage['groundVehicleFilter'] = 'not_filtered';
	}
	var groundFilter = localStorage['groundVehicleFilter'];
	if (switchFilter === true) {
		groundFilter = (groundFilter === 'not_filtered') ? 'filtered' : 'not_filtered';
	}
	if (groundFilter === 'not_filtered') {
		$('#groundvehicle_filter').addClass('settingsCheckboxChecked');
	} else {
		$('#groundvehicle_filter').removeClass('settingsCheckboxChecked');
	}
	localStorage['groundVehicleFilter'] = groundFilter;
	PlaneFilter.groundVehicles = groundFilter;
}

function filterBlockedMLAT(switchFilter) {
	if (typeof localStorage['blockedMLATFilter'] === 'undefined') {
		localStorage['blockedMLATFilter'] = 'not_filtered';
	}
	var blockedMLATFilter = localStorage['blockedMLATFilter'];
	if (switchFilter === true) {
		blockedMLATFilter = (blockedMLATFilter === 'not_filtered') ? 'filtered' : 'not_filtered';
	}
	if (blockedMLATFilter === 'not_filtered') {
		$('#blockedmlat_filter').addClass('settingsCheckboxChecked');
	} else {
		$('#blockedmlat_filter').removeClass('settingsCheckboxChecked');
	}
	localStorage['blockedMLATFilter'] = blockedMLATFilter;
	PlaneFilter.blockedMLAT = blockedMLATFilter;
}

function toggleAltitudeChart(switchToggle) {
	if (typeof localStorage['altitudeChart'] === 'undefined') {
		localStorage['altitudeChart'] = 'show';
	}
	var altitudeChartDisplay = localStorage['altitudeChart'];
	if (switchToggle === true) {
		altitudeChartDisplay = (altitudeChartDisplay === 'show') ? 'hidden' : 'show';
	}
    // if you're using custom colors always hide the chart
    if (customAltitudeColors === true) {
        altitudeChartDisplay = 'hidden';
        // also hide the control option
        $('#altitude_chart_container').hide();
    }
	if (altitudeChartDisplay === 'show') {
		$('#altitude_checkbox').addClass('settingsCheckboxChecked');
		$('#altitude_chart').show();
	} else {
		$('#altitude_checkbox').removeClass('settingsCheckboxChecked');
		$('#altitude_chart').hide();
	}
	localStorage['altitudeChart'] = altitudeChartDisplay;
}

function onResetAltitudeFilter(e) {
    $("#altitude_filter_min").val("");
    $("#altitude_filter_max").val("");

    updatePlaneFilter();
    refreshTableInfo();
}

function updatePlaneFilter() {
    var minAltitude = parseFloat($("#altitude_filter_min").val().trim());
    var maxAltitude = parseFloat($("#altitude_filter_max").val().trim());

    if (minAltitude === NaN) {
        minAltitude = -Infinity;
    }

    if (maxAltitude === NaN) {
        maxAltitude = Infinity;
    }

    PlaneFilter.minAltitude = minAltitude;
    PlaneFilter.maxAltitude = maxAltitude;
    PlaneFilter.altitudeUnits = DisplayUnits;
}

function getFlightAwareIdentLink(ident, linkText) {
    if (ident !== null && ident !== "") {
        if (!linkText) {
            linkText = ident;
        }
        return "<a target=\"_blank\" href=\"https://flightaware.com/live/flight/" + ident.trim() + "\">" + linkText + "</a>";
    }

    return "";
}

function getFlightAwareModeSLink(code, ident, linkText) {
    if (code !== null && code.length > 0 && code[0] !== '~' && code !== "000000") {
        if (!linkText) {
            linkText = "FlightAware: " + code.toUpperCase();
        }

        var linkHtml = "<a target=\"_blank\" href=\"https://flightaware.com/live/modes/" + code ;
        if (ident !== null && ident !== "") {
            linkHtml += "/ident/" + ident.trim();
        }
        linkHtml += "/redirect\">" + linkText + "</a>";
        return linkHtml;
    }

    return "";
}

function getFlightAwarePhotoLink(registration) {
    if (registration !== null && registration !== "") {
        return "<a target=\"_blank\" href=\"https://flightaware.com/photos/aircraft/" + registration.replace(/[^0-9a-z]/ig,'') + "\">See Photos</a>";
    }

    return "";   
}

function getAirframesModeSLink(code) {
    if (code !== null && code.length > 0 && code[0] !== '~' && code !== "000000") {
        return "<a href=\"http://www.airframes.org/\" onclick=\"$('#airframes_post_icao').attr('value','" + code + "'); document.getElementById('horrible_hack').submit.call(document.getElementById('airframes_post')); return false;\">Airframes.org: " + code.toUpperCase() + "</a>";
    }

    return "";   
}


// takes in an elemnt jQuery path and the OL3 layer name and toggles the visibility based on clicking it
function toggleLayer(element, layer) {
	// set initial checked status
	ol.control.LayerSwitcher.forEachRecursive(layers, function(lyr) { 
		if (lyr.get('name') === layer && lyr.getVisible()) {
			$(element).addClass('settingsCheckboxChecked');
		}
	});
	$(element).on('click', function() {
		var visible = false;
		if ($(element).hasClass('settingsCheckboxChecked')) {
			visible = true;
		}
		ol.control.LayerSwitcher.forEachRecursive(layers, function(lyr) { 
			if (lyr.get('name') === layer) {
				if (visible) {
					lyr.setVisible(false);
					$(element).removeClass('settingsCheckboxChecked');
				} else {
					lyr.setVisible(true);
					$(element).addClass('settingsCheckboxChecked');
				}
			}
		});
	});
}

// check status.json if it has a serial number for a flightfeeder
function flightFeederCheck() {
	$.ajax('/status.json', {
		success: function(data) {
			if (data.type === "flightfeeder") {
				isFlightFeeder = true;
				updatePiAwareOrFlightFeeder();
			}
		}
	})
}

// updates the page to replace piaware with flightfeeder references
function updatePiAwareOrFlightFeeder() {
	if (isFlightFeeder) {
		$('.piAwareLogo').hide();
		$('.flightfeederLogo').show();
		PageName = 'FlightFeeder Skyview';
	} else {
		$('.flightfeederLogo').hide();
		$('.piAwareLogo').show();
		PageName = 'PiAware Skyview';
	}
	refreshPageTitle();
}
