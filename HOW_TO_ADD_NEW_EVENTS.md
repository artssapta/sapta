# How to Add a New Event to the SAPTA Website

Adding a new event is incredibly easy! You **do not** need to create any new HTML files or code anything from scratch. The website is built to automatically generate the beautiful layout you see right now as long as you provide the text and images.

All you have to do is edit a single file: `src/content/pages/events.md`

## Steps to Add a New Event

1. **Add your images and videos:**
   - Put your event photos and flyer inside the `public/assets/` folder (you can create a new subfolder for them like `public/assets/my_new_event/`).

2. **Open the events file:**
   - Open `src/content/pages/events.md` in your code editor.

3. **Copy and Paste the Template:**
   - Find the `events:` section in the file.
   - Copy the template below and paste it as a new entry under `events:`. Be sure to keep the indentation (spaces) the exact same as the other events!

### The Event Template

```yaml
      - id: my-new-event                     # A unique ID for the event (no spaces)
        title: My Amazing Event              # The main title
        subtitle: A beautiful subtitle       # Optional subtitle
        date: "October 20, 2026"             # Date of the event
        time: "4 PM - 7 PM"                  # Optional time
        location: "San Ramon, CA"            # Optional location
        description: "This is a detailed description of the event. You can write as much as you want here."
        flyerImage: "/assets/my_flyer.jpg"   # The path to the main flyer image
        gallery:                             # A list of all photos for the event
          - src: "/assets/photo1.jpg"
            alt: "Concert Photo 1"
          - src: "/assets/photo2.jpg"
            alt: "Concert Photo 2"
        videos:                              # A list of YouTube links
          - title: "Performance Part 1"
            videoUrl: "https://www.youtube.com/watch?v=YOUR_LINK_HERE"
```

### Tips
- **Order matters!** Whichever event is listed first in the file will be the one that shows up first on the website.
- **YouTube Links:** You can just paste standard YouTube links under `videoUrl`.
- **Missing Information:** If you don't have videos, just leave `videos: []`. If you don't have a time, you can delete the `time:` line entirely!
