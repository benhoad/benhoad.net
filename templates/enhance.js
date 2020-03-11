function queryAll(selector, parent) {
  return [].slice.call(document.querySelectorAll(selector, parent));
}

this.state = {};

window.addEventListener("DOMContentLoaded", function() {
  //
  // Image captions
  //
  queryAll("img + br + em, a + br + em").forEach(function(em) {
    var p = em.parentElement;
    var figure = document.createElement("figure");

    // Bail out if the main element is a link but not an image
    if (
      p.firstElementChild.tagName === "A" &&
      !p.firstElementChild.querySelector("img")
    )
      return;

    // Add image (or link if it is one)
    figure.appendChild(p.firstElementChild);

    // Add the caption
    var figcaption = document.createElement("figcaption");
    figcaption.innerHTML = em.innerHTML;
    figure.appendChild(figcaption);

    p.parentElement.insertBefore(figure, p);
    p.parentElement.removeChild(p);
  });

  //
  // Quotes
  //
  queryAll("blockquote").forEach(function(quote) {
    var lines = [].slice.call(quote.children);
    var lastLine = lines[lines.length - 1];

    if (lastLine.querySelector('a[href*="twitter.com/benhoad/status"]')) {
      quote.className = "tweet";
      quote.removeChild(lastLine);
      lastLine.innerHTML = lastLine.innerHTML.replace("--", "");
      // Published time
      var time = lastLine.querySelector("a");
      time.className = "tweet-time";
      lastLine.removeChild(time);
      quote.appendChild(time);
      // Profile
      var matches = lastLine.innerText.match(/([^\(]+)\(([^\)]+)/, "");
      var name = matches[1].trim();
      var verified = name.endsWith("*");
      name = name.replace(/\*$/, "");
      var handle = matches[2];
      var author = document.createElement("a");
      author.href = "https://twitter.com/" + handle.replace("@", "");
      author.className = "tweet-profile";
      author.innerHTML =
        '<img src="/twitter-profile.jpg" /><strong>' +
        name +
        (verified ? " <em>✔</em>" : "") +
        "</strong> " +
        handle;
      quote.insertBefore(author, quote.firstElementChild);
    } else if (lastLine.innerText.startsWith("--")) {
      line.className = "author";
      line.innerHTML = line.innerHTML.replace(/^\-\-/, "&mdash;");
    }
  });

  //
  // General sections
  //
  queryAll('section[data-type="wide"]').forEach(function(section) {
    section.className = "section-wide";
  });

  queryAll('section[data-type="full"]').forEach(function(section) {
    section.className = "section-full";
  });

  queryAll('section[data-type="pull-right"]').forEach(function(section) {
    section.className = "section-right";
  });

  queryAll('section[data-type="pull-left"]').forEach(function(section) {
    section.className = "section-left";
  });

  //
  // Full screen scrolly sections
  //
  queryAll('section[data-type="block"]').forEach(function(section) {
    // The first element is the background
    var media = section.firstElementChild;
    var caption;

    switch (media.tagName) {
      case "FIGURE":
        caption = media.querySelector("figcaption");
        media = media.querySelector("img");
        break;

      case "VIDEO":
      // Do nothing. We already have the video

      case "CANVAS":

        break;
      case "IMG":
      // Do nothing. We already have the image

      default:
        media = media.querySelector("img");
    }
    // No background found so bail early
    if (!media) return;

    section.className += " section-block";

    section.removeChild(section.firstElementChild);
    // Set up the fixed background
    var background = document.createElement("div");
    background.className = "block-background";
    background.appendChild(media);
    if (caption) {
      background.appendChild(caption);
    }
    section.insertBefore(background, section.firstElementChild);

    // All other children get put into little boxes
    [].slice.call(section.children).forEach(function(child) {
      if (child.tagName !== "P") return;

      var panel = document.createElement("div");
      panel.className = "block-panel";
      if (section.getAttribute("data-colour") === "light") {
        panel.className += " block-panel-light";
      }
      panel.appendChild(child);
      section.appendChild(panel);

      // if canvas/frames set listener for scrolling into view
      if(media.tagName == "CANVAS" && media.getAttribute('data-type') == 'frames'){
        if(!this.state.frame_triggers){this.state.frame_triggers = []} 
        let frame = parseInt(child.getAttribute('data-frame'));
        if(frame){
          this.state.frame_triggers.push({elem: child, parent: panel, target_frame: frame});
        }
      }

    });

    if(media.tagName == "CANVAS" && media.getAttribute('data-type') == 'frames'){
      let ctx = media.getContext('2d');
      let start = parseInt(media.getAttribute('data-start'));
      let end = parseInt(media.getAttribute('data-end'));
      this.state.frames = [];
      this.state.frame_section = section;

      //preload frames
      function loadFrames( start, end, callback){
        
        let loadedImageCount = 0;
        for (var i = start; i <= end; i++){
          var img = new Image();
          img.onload = imageLoaded;
          img.src = pad(i,4) + '.jpg';
          this.state.frames[i] = img;
        }

        function imageLoaded(e) {
          loadedImageCount++;
          if (loadedImageCount >= end) {
              callback();
          }
        }
      }

      loadFrames(start, end, function(){
        //instantiate canvas
        this.state.ctx = ctx;
        this.state.current_frame = start;
        this.state.is_animating = false;
        setFrameTo(this.state.current_frame);

        //setup listeners
        this.state.frame_triggers.forEach(function(frame){
          frame.parent.addEventListener('click', function(){
            animateToFrame(frame.target_frame)
          });
        });

        checkBounds(start,end, true);

        this.window.addEventListener('scroll', function(e){
          checkBounds(start,end);
        })
      });
    }
  });

  function checkBounds(start,end,immediate){
    let bounds = this.state.frame_section.getBoundingClientRect()
    let delta = -1 * bounds.top;

    if(delta <= 0){
      if(this.state.is_animating && delta >= window.innerHeight *-1){
        this.state.target_frame = start;
      }else{
        this.state.is_animating = false;
        this.state.target_frame = start;
        setFrameTo(start);
      }

    }else if (delta >= bounds.height){
        this.state.is_animating = false;
        this.state.target_frame = end;
        setFrameTo(end);
      
    }else{
      let current_frame_id = Math.round(delta/bounds.height * this.state.frame_triggers.length);
      if(current_frame_id >= 0 && current_frame_id <= this.state.frame_triggers.length-1){
        if(immediate){
          setFrameTo(this.state.frame_triggers[current_frame_id].target_frame);
        }else{
          animateToFrame(this.state.frame_triggers[current_frame_id].target_frame);
        }
        
      }
    }
  }

  function animateToFrame(target_frame){
    let fps = 30;
    this.state.target_frame = target_frame;

    if(!this.state.is_animating){
      this.state.is_animating = true;
      function renderFrame(){
        let delta = this.state.target_frame > this.state.current_frame ? 1 : -1;
        if(this.state.target_frame != this.state.current_frame && this.state.is_animating){
          this.state.current_frame += delta;
          setFrameTo(this.state.current_frame);
          setTimeout(function() {
            window.requestAnimationFrame(renderFrame);
          }, 1000 / fps);
        }else{
          this.state.is_animating = false;
        }
      };
      window.requestAnimationFrame(renderFrame);
    }
  }

  function setFrameTo(target_frame){
    this.state.current_frame = target_frame;
    this.state.ctx.drawImage(this.state.frames[target_frame],0,0);
  }


  //
  // Galleries
  //
  queryAll('section[data-type="gallery"]').forEach(function(section) {
    section.className = "section-wide section-gallery";

    var items = [].slice.call(section.children);
    items.forEach(function(child) {
      section.removeChild(child);
    });

    // Set up rows
    var rowClasses = ["one", "two", "three", "four"];
    var rowCounts = (section.getAttribute("data-layout") || "")
      .split(",")
      .map(function(n) {
        return parseInt(n, 10);
      });
    for (var r = 0; r < rowCounts.length; r++) {
      var row = document.createElement("div");
      row.className = "row " + rowClasses[rowCounts[r] - 1];
      section.appendChild(row);
      for (var i = 0; i < rowCounts[r]; i++) {
        row.appendChild(items.shift());
      }
    }
  });

  function pad(n, width, z) {
    z = z || '0';
    n = n + '';
    return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
  }
});
