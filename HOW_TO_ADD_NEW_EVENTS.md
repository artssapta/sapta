# Guide: How to Add New Events and Photos (No Coding Required)

This guide shows you how to add new events or update photos/videos on the website. You **do not** need any coding experience! You only need to edit one text file.

The events file is located at: `src/content/pages/events.md`

---

## 📋 The Main Steps

1. **Upload your photos to Cloudinary** (e.g. `https://cloudinary.com`).
2. **Copy the image links** from Cloudinary.
3. **Open the events file** (`events.md`) in your editor.
4. **Copy and paste the template** (below) at the top of the `events:` list.

---

## 📝 The Event Template (Copy & Paste)

Copy this block of text, paste it under the `events:` line in `src/content/pages/events.md`, and replace the text inside the quotes with your event details:

```yaml
      - id: unique-event-name                # A unique ID for this event (use lowercase and hyphens, no spaces. e.g. "summer-concert")
        title: "Name of Event"               # The main title displayed on the site
        subtitle: "A Catchy Subtitle"        # Optional: A short subtitle/slogan. If none, delete this line.
        date: "June 25, 2026"                # The date of the event
        time: "3 PM - 5 PM"                  # Optional: Time of the event. If none, delete this line.
        location: "Location Name, City, CA"  # Optional: Location of the event. If none, delete this line.
        description: "Write your event description here. You can write as many sentences as you want."
        flyerImage: "/assets/flyer_name.jpg" # The image path for the event flyer.
        gallery:                             # The list of photo links from Cloudinary
          - src: "https://res.cloudinary.com/.../photo1.jpg"
            alt: "Caption describing photo 1"  # This is the caption/description for the photo
          - src: "https://res.cloudinary.com/.../photo2.jpg"
            alt: "Caption describing photo 2"
        videos:                              # Optional: YouTube links for performances
          - title: "Performance Title"
            videoUrl: "https://www.youtube.com/watch?v=..."
```

---

## 💡 Quick Tips for Beginners

### 1. Formatting & Spacing (Crucial!)
YAML files (like `events.md`) are very sensitive to spacing.
* **Never use the Tab key** to align lines. Always use the Spacebar.
* Make sure your new event starts with `- id:` and aligns exactly with the other events in the file.
* Keep the quotes (`""`) around your text fields.

### 2. How to Add Captions/Descriptions to Photos
In the gallery list, each photo has an `alt:` line:
```yaml
          - src: "https://res.cloudinary.com/.../photo1.jpg"
            alt: "Group photo of all performing student artists"
```
The text you type inside the quotes after `alt:` serves as the description and accessibility caption for that specific photo.

### 3. How to Order Your Events
The website displays events in the exact order they are listed in the file.
* If you want a new event to show up **first**, paste its block at the very top of the list (right under the `events:` line).
* If you want it to show up **second**, paste it below the first event block.

### 4. Handling Missing Info
If you don't have something, you don't need to leave empty placeholder lines. You can just delete them or leave them empty:
* No videos? Write: `videos: []`
* No photos? Write: `gallery: []`
* No subtitle? Simply delete the `subtitle:` line entirely.
