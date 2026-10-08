import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { videoSource, registrationLink } from './lib/media.mjs';

const optionalText = z.string().nullish().transform(value => value ?? '');
const eventSchema = z.object({
  title: z.string().min(1),
  order: z.number().int().min(1).default(99),
  status: z.enum(['upcoming', 'past']).default('past'),
  subtitle: optionalText,
  date: z.string().min(1),
  time: optionalText,
  location: optionalText,
  description: optionalText,
  flyerImage: z.string().min(1),
  gallery: z.array(z.object({ src: z.string().min(1), alt: optionalText })).nullish().transform(value => value ?? []),
  videos: z.array(z.object({
    title: optionalText,
    source: z.enum(['youtube', 'upload']).default('youtube'),
    file: optionalText,
    videoUrl: optionalText,
  }).refine(video => videoSource(video.source === 'upload' ? video.file : video.videoUrl)?.kind === (video.source === 'upload' ? 'file' : 'youtube'), {
    message: 'Add a valid YouTube URL, or choose Upload and select an MP4 or WebM file.',
  })).nullish().transform(value => value ?? []),
});

const events = defineCollection({
  loader: glob({ pattern: '*.md', base: 'src/content/events' }),
  schema: eventSchema,
});

const registrations = defineCollection({
  loader: glob({ pattern: '*.md', base: 'src/content/registrations' }),
  schema: z.object({
    title: z.string().min(1),
    status: z.enum(['coming-soon', 'open']).default('coming-soon'),
    // Shown while "coming soon".
    message: z.string().min(1),
    // Shown instead while open (a default is used when empty).
    openMessage: optionalText,
    url: optionalText,
  }).refine(value => value.status !== 'open' || !!registrationLink(value.url), {
    message: 'An open registration must have a valid HTTPS form link.',
    path: ['url'],
  }),
});

const pages = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "src/content/pages" }),
  schema: z.object({
    title: z.string(),
    blocks: z.array(z.discriminatedUnion('type', [
      z.object({
        type: z.literal('hero'),
        title: z.string(),
        subtitle: z.string().optional(),
        color: z.string().optional(),
        showDonate: z.boolean().optional(),
      }),
      z.object({
        type: z.literal('about'),
        title: z.string(),
        text: z.string(),
        image: z.string(),
        imageSide: z.enum(['left', 'right']).optional(),
      }),
      z.object({
        type: z.literal('events'),
        title: z.string(),
        color: z.string().optional(),
        events: z.array(z.object({
          id: z.string(),
          status: z.enum(['upcoming', 'past']).optional(),
          title: z.string(),
          subtitle: z.string().optional(),
          date: z.string(),
          time: z.string().optional(),
          location: z.string().optional(),
          description: z.string().optional(),
          flyerImage: z.string(),
          gallery: z.array(z.object({
            src: z.string(),
            alt: z.string().optional(),
          })).optional(),
          videos: z.array(z.object({
            title: z.string().optional(),
            videoUrl: z.string(),
          })).optional(),
        })).optional(),
      }),
      z.object({
        type: z.literal('team-grid'),
        title: z.string().optional(),
      }),
      z.object({
        type: z.literal('google-form'),
        url: z.string(),
        height: z.string().optional(),
      }),
      z.object({
        type: z.literal('text'),
        heading: z.string().optional(),
        text: z.string().optional(),
        alignment: z.enum(['left', 'center', 'right']).optional(),
      }),
      z.object({
        type: z.literal('youtube'),
        title: z.string().optional(),
        videoUrl: z.string().optional(),
      }),
      z.object({
        type: z.literal('gallery'),
        title: z.string().optional(),
        images: z.array(z.object({
          src: z.string(),
          alt: z.string().optional(),
        })).optional(),
      }),
    ])),
  }),
});

const team = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "src/content/team" }),
  schema: z.object({
    name: z.string(),
    role: z.string(),
    photo: z.string().optional(),
    order: z.number().optional(),
  }),
});

export const collections = { team, pages, events, registrations };
