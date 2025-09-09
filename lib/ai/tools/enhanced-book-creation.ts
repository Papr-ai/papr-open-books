import { z } from 'zod';
import { tool, type ToolCallOptions } from 'ai';
import type { Session } from 'next-auth';
import type { DataStreamWriter } from '@/lib/types';
import type { CreateImageOutput } from './create-image';

// Import FormattedMemory type for memory operations
interface FormattedMemory {
  id: string;
  content?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

// Enhanced Book Creation Workflow Tool
// Implements the complete 7-step book creation process with approval gates

// Base schemas for book creation workflow
const bookPlanningSchema = z.object({
  bookTitle: z.string().describe('The title of the book'),
  genre: z.string().describe('Genre of the book (e.g., children\'s adventure, fantasy, mystery)'),
  targetAge: z.string().describe('Target age group (e.g., 4-8 years, 8-12 years)'),
  premise: z.string().describe('High-level story premise and plot outline'),
  themes: z.array(z.string()).describe('Main themes of the book'),
  mainCharacters: z.array(z.object({
    name: z.string(),
    role: z.string().describe('Character role (protagonist, antagonist, sidekick, etc.)'),
    personality: z.string().describe('Character personality traits and motivations'),
    physicalDescription: z.string().describe('Detailed physical appearance for consistency'),
    backstory: z.string().optional().describe('Character backstory and history')
  })).describe('Main characters with detailed descriptions'),
  styleBible: z.string().describe('Art and writing style guidelines for consistency'),
  isPictureBook: z.boolean().describe('Whether this is a picture book requiring illustrations'),
  conversationContext: z.string().optional().describe('CRITICAL: Full context from the chat conversation including all character details, plot points, and story elements discussed. This ensures consistency with what was established in the conversation.'),
  skipMemorySearch: z.boolean().optional().default(false).describe('Set to true if the AI has already searched memories and has all necessary context from the conversation'),
  autoCreateDocuments: z.boolean().optional().default(false).describe('Set to true to automatically create character profile and outline documents using createDocument tool'),
  skipApprovalGate: z.boolean().optional().default(false).describe('Set to true when user has indicated to proceed/continue without explicit approval')
});

const chapterDraftSchema = z.object({
  bookId: z.string().describe('The book ID from the planning phase'),
  chapterNumber: z.number().describe('Chapter number'),
  chapterTitle: z.string().describe('Chapter title'),
  chapterText: z.string().describe('Full chapter text content'),
  wordCount: z.number().describe('Word count of the chapter'),
  keyEvents: z.array(z.string()).describe('Key story events in this chapter')
});

const sceneSegmentationSchema = z.object({
  bookId: z.string().describe('The book ID'),
  chapterNumber: z.number().describe('Chapter number to segment'),
  scenes: z.array(z.object({
    sceneId: z.string().describe('Unique scene identifier'),
    sceneNumber: z.number().describe('Scene number within chapter'),
    synopsis: z.string().describe('Brief scene synopsis'),
    environment: z.object({
      location: z.string().describe('Location/setting name'),
      timeOfDay: z.enum(['dawn', 'morning', 'midday', 'afternoon', 'evening', 'night']),
      weather: z.string().describe('Weather conditions'),
      mood: z.string().describe('Environmental mood/atmosphere'),
      description: z.string().describe('Detailed environment description')
    }),
    requiredCharacters: z.array(z.string()).describe('Character names required in this scene'),
    requiredProps: z.array(z.string()).describe('Props/objects required in this scene'),
    continuityNotes: z.string().optional().describe('Important continuity requirements')
  })).describe('Scenes broken down from the chapter')
});

const characterPortraitSchema = z.object({
  bookId: z.string().describe('The book ID'),
  characterName: z.string().describe('Character name to create portrait for'),
  generatePortrait: z.boolean().describe('Whether to generate a new portrait or use existing'),
  portraitStyle: z.string().describe('Art style for the portrait (consistent with book style)'),
  transparentBackground: z.boolean().default(true).describe('Whether to generate with transparent/white background for scene composition'),
  baseOutfit: z.string().describe('Description of the character\'s base outfit - their standard, consistent clothing worn throughout the book'),
  props: z.array(z.object({
    propName: z.string(),
    description: z.string(),
    mustPresent: z.boolean().describe('Whether this prop must appear in every scene with this character'),
    size: z.string().describe('Relative size (small, medium, large)'),
    material: z.string().describe('Material/texture of the prop')
  })).optional().describe('Associated character props to create')
});

const environmentCreationSchema = z.object({
  bookId: z.string().describe('The book ID'),
  environmentId: z.string().describe('Unique environment identifier'),
  location: z.string().describe('Location name'),
  timeOfDay: z.string().describe('Time of day'),
  weather: z.string().describe('Weather conditions'),
  masterPlateDescription: z.string().describe('Detailed description for the environment master plate'),
  persistentElements: z.array(z.string()).describe('Elements that should remain consistent (signage, furniture, etc.)'),
  layoutJson: z.record(z.string(), z.any()).describe('Layout information for prop placement'),
  aspectRatio: z.enum(['16:9', '4:3', '1:1', '3:4', '9:16']).default('16:9')
});

const sceneCompositionSchema = z.object({
  bookId: z.string().describe('The book ID'),
  sceneId: z.string().describe('Scene ID to render'),
  environmentId: z.string().describe('Environment to use as base'),
  characterIds: z.array(z.string()).describe('Character IDs to include'),
  propIds: z.array(z.string()).describe('Prop IDs to include'),
  sceneDescription: z.string().describe('Detailed scene description'),
  lighting: z.string().describe('Lighting conditions'),
  cameraAngle: z.string().describe('Camera angle/perspective'),
  compositionalNotes: z.string().optional().describe('Special compositional requirements'),
  seed: z.number().optional().describe('Random seed for consistency')
});

// Step 1: High-level Story + Character Planning Tool
export const createBookPlan = ({ session, dataStream }: { session: Session; dataStream: DataStreamWriter }) =>
  tool({
    description: `Step 1 of Enhanced Book Creation: Plan high-level story, themes, and main characters.
    
    🚨 CRITICAL REQUIREMENTS:
    1. ALWAYS searches memory FIRST for existing book plans, character information, and related content
    2. MUST receive conversationContext parameter with ALL details from the chat conversation
    3. Uses existing context to build upon previous work, ensuring NO information is lost
    
    The conversationContext parameter is ESSENTIAL to preserve:
    - Character names, ages, genders, and descriptions from the conversation
    - Plot details and story elements discussed in chat
    - User preferences and specific requirements mentioned
    - Any existing character portraits or images referenced
    
    This tool creates the foundational elements of your book:
    - Story premise and themes
    - Main character personalities and descriptions
    - Art/writing style bible
    - Determines if it's a picture book
    
    After completion, user approval is required before proceeding to Step 2 (Chapter Writing).`,
    inputSchema: bookPlanningSchema,
    execute: async (input) => {
      const { bookTitle, genre, targetAge, premise, themes, mainCharacters, styleBible, isPictureBook, conversationContext, skipMemorySearch, autoCreateDocuments, skipApprovalGate } = input;
      
      // Validate that conversation context was provided
      if (!conversationContext || conversationContext.length < 50) {
        console.warn('[createBookPlan] ⚠️ WARNING: conversationContext is missing or very short. This may result in character details being lost or changed!');
        console.warn('[createBookPlan] conversationContext length:', conversationContext?.length || 0);
      } else {
        console.log('[createBookPlan] ✅ Conversation context provided:', conversationContext.substring(0, 100) + '...');
      }

      // CONDITIONALLY SEARCH MEMORY - skip if AI already has context
      let existingBookContext = '';
      let existingCharacters: any[] = [];
      
      if (!skipMemorySearch && session?.user?.id) {
        try {
          const { createMemoryService } = await import('@/lib/ai/memory/service');
          const { ensurePaprUser } = await import('@/lib/ai/memory/middleware');
          const apiKey = process.env.PAPR_MEMORY_API_KEY;
          
          if (apiKey) {
            const memoryService = createMemoryService(apiKey);
            const paprUserId = await ensurePaprUser(session.user.id, apiKey);
            
            if (paprUserId) {
              console.log('[createBookPlan] Searching memory for existing book plans and characters...');
              
              // Search for existing book plans
              const bookMemories = await memoryService.searchMemories(
                paprUserId,
                `book brief "${bookTitle}" story premise themes characters`,
                10
              );
              
              if (bookMemories.length > 0) {
                existingBookContext = bookMemories.map(mem => mem.content).join('\n\n');
                console.log(`[createBookPlan] Found ${bookMemories.length} existing book-related memories`);
              }
              
              // Search for existing characters mentioned in the plan
              for (const character of mainCharacters) {
                const charMemories = await memoryService.searchMemories(
                  paprUserId,
                  `character "${character.name}" personality description portrait`,
                  5
                );
                
                if (charMemories.length > 0) {
                  existingCharacters.push({
                    name: character.name,
                    existingInfo: charMemories.map(mem => mem.content).join('\n'),
                    memories: charMemories
                  });
                  console.log(`[createBookPlan] Found existing information for character: ${character.name}`);
                }
              }
            }
          }
        } catch (error) {
          console.error('[createBookPlan] Error searching memory:', error);
        }
      }
      
      dataStream.write?.({
        type: 'kind',
        content: 'book_plan',
      });

      dataStream.write?.({
        type: 'title',
        content: `${bookTitle} - Story Plan`,
      });

      // Generate unique book ID using proper UUID format
      const { generateUUID } = await import('@/lib/utils');
      const bookId = generateUUID();

      dataStream.write?.({
        type: 'id',
        content: bookId,
      });

      // Save book plan to memory with existing context integration
      if (session?.user?.id) {
        try {
          const { createMemoryService } = await import('@/lib/ai/memory/service');
          const { ensurePaprUser } = await import('@/lib/ai/memory/middleware');
          const apiKey = process.env.PAPR_MEMORY_API_KEY;
          
          if (apiKey) {
            const memoryService = createMemoryService(apiKey);
            const paprUserId = await ensurePaprUser(session.user.id, apiKey);
            
            if (paprUserId) {
              // Save enhanced book brief with existing context AND conversation context
              const bookBriefContent = `Book: ${bookTitle}

Genre: ${genre}
Target Age: ${targetAge}

Premise: ${premise}

Themes: ${themes.join(', ')}

Style Bible: ${styleBible}

${conversationContext ? `\n--- CONVERSATION CONTEXT ---\n${conversationContext}` : ''}

${existingBookContext ? `\n--- EXISTING CONTEXT FROM MEMORY ---\n${existingBookContext}` : ''}`;

              await memoryService.storeContent(
                paprUserId,
                bookBriefContent,
                'text',
                {
                  kind: 'book_brief',
                  book_id: bookId,
                  book_title: bookTitle,
                  genre,
                  target_age: targetAge,
                  is_picture_book: isPictureBook,
                  step: 'planning',
                  status: 'pending_approval',
                  has_existing_context: existingBookContext.length > 0,
                  has_conversation_context: !!conversationContext
                },
                session.user.id
              );

              // Save or update character bios in memory
              for (const character of mainCharacters) {
                const existingChar = existingCharacters.find(ec => ec.name === character.name);
                
                const characterContent = `Character: ${character.name}

Role: ${character.role}
Personality: ${character.personality}
Physical Description: ${character.physicalDescription}
${character.backstory ? `Backstory: ${character.backstory}` : ''}`;

                const characterMetadata = {
                  kind: 'character',
                  book_id: bookId,
                  book_title: bookTitle,
                  character_name: character.name,
                  character_role: character.role,
                  step: 'planning',
                  status: 'pending_approval',
                  updated_at: new Date().toISOString()
                };

                if (existingChar && existingChar.memories && existingChar.memories.length > 0) {
                  // Update the most recent existing memory instead of creating a new one
                  const mostRecentMemory = existingChar.memories[0]; // First result is usually most recent
                  console.log(`[createBookPlan] Updating existing memory for character: ${character.name}`);
                  
                  await memoryService.updateMemory(
                    mostRecentMemory.id,
                    {
                      content: characterContent,
                      metadata: {
                        customMetadata: characterMetadata
                      }
                    }
                  );
                } else {
                  // Create new memory if none exists
                  console.log(`[createBookPlan] Creating new memory for character: ${character.name}`);
                  
                  await memoryService.storeContent(
                    paprUserId,
                    characterContent,
                    'text',
                    characterMetadata,
                    session.user.id
                  );
                }
              }
            }
          }
        } catch (error) {
          console.error('[createBookPlan] Error saving to memory:', error);
        }
      }

      // AUTOMATICALLY CREATE DOCUMENTS if requested
      if (autoCreateDocuments) {
        try {
          console.log('[createBookPlan] Auto-creating character profiles and outline documents...');
          
          // Import createDocument tool
          const { createDocument } = await import('./create-document');
          const docTool = createDocument({ session, dataStream });

          // Create character profiles document
          const characterProfilesContent = mainCharacters.map(char => 
            `## ${char.name}
**Role**: ${char.role}
**Personality**: ${char.personality}  
**Physical Description**: ${char.physicalDescription}
${char.backstory ? `**Backstory**: ${char.backstory}` : ''}`
          ).join('\n\n');

          const characterContext = `${conversationContext || ''}\n\nBook: ${bookTitle}\nGenre: ${genre}\nTarget Age: ${targetAge}`;
          
          if (docTool.execute) {
            await docTool.execute({
              title: `${bookTitle} - Character Profiles`,
              kind: 'text',
              conversationContext: characterContext
            }, { toolCallId: 'char-profiles-' + Date.now(), messages: [] });
          }

          // Create story outline document  
          const outlineContent = `# ${bookTitle} - Story Outline

**Genre**: ${genre}
**Target Age**: ${targetAge}

## Premise
${premise}

## Themes
${themes.map(theme => `- ${theme}`).join('\n')}

## Main Characters
${mainCharacters.map(char => `- **${char.name}**: ${char.role} - ${char.personality}`).join('\n')}

## Style Bible
${styleBible}`;

          if (docTool.execute) {
            await docTool.execute({
              title: `${bookTitle} - Story Outline`,
              kind: 'text', 
              conversationContext: characterContext
            }, { toolCallId: 'outline-' + Date.now(), messages: [] });
          }

          console.log('[createBookPlan] ✅ Auto-created character profiles and outline documents');
        } catch (docError) {
          console.error('[createBookPlan] Error creating documents:', docError);
        }
      }

      // ASYNC DATABASE STORAGE for characters and props
      if (session?.user?.id) {
        // Don't await this - run in background
        saveCharactersToDatabase(session.user.id, bookId, bookTitle, mainCharacters).catch(error => {
          console.error('[createBookPlan] Background database save failed:', error);
        });
      }

      return {
        success: true,
        bookId,
        bookTitle,
        genre,
        targetAge,
        premise,
        themes,
        mainCharacters,
        styleBible,
        isPictureBook,
        existingContext: {
          foundBookContext: existingBookContext.length > 0,
          foundCharacters: existingCharacters.length,
          characterDetails: existingCharacters.map(ec => ({ name: ec.name, hasExistingInfo: true }))
        },
        documentsCreated: autoCreateDocuments,
        nextStep: skipApprovalGate ? 'Proceeding to Step 2 (Chapter Drafting)' : 'Approval Gate 1: Please review and approve the story plan and character bios before proceeding to chapter writing.',
        approvalRequired: !skipApprovalGate
      };
    },
  });

// Step 2: Chapter Text Drafting Tool
export const draftChapter = ({ session, dataStream }: { session: Session; dataStream: DataStreamWriter }) =>
  tool({
    description: `Step 2 of Enhanced Book Creation: Draft full chapter text.
    
    Creates complete chapter content based on the approved book plan.
    Requires approval before proceeding to Step 3 (Scene Segmentation for picture books).`,
    inputSchema: chapterDraftSchema,
    execute: async (input) => {
      const { bookId, chapterNumber, chapterTitle, chapterText, wordCount, keyEvents } = input;
      
      dataStream.write?.({
        type: 'kind',
        content: 'chapter_draft',
      });

      dataStream.write?.({
        type: 'title',
        content: `Chapter ${chapterNumber}: ${chapterTitle}`,
      });

      dataStream.write?.({
        type: 'id',
        content: `${bookId}_chapter_${chapterNumber}`,
      });

      // Save chapter draft to memory and database
      if (session?.user?.id) {
        try {
          // Save to memory first
          const { createMemoryService } = await import('@/lib/ai/memory/service');
          const { ensurePaprUser } = await import('@/lib/ai/memory/middleware');
          const apiKey = process.env.PAPR_MEMORY_API_KEY;
          
          if (apiKey) {
            const memoryService = createMemoryService(apiKey);
            const paprUserId = await ensurePaprUser(session.user.id, apiKey);
            
            if (paprUserId) {
              await memoryService.storeContent(
                paprUserId,
                `Chapter ${chapterNumber}: ${chapterTitle}\n\n${chapterText}\n\nKey Events: ${keyEvents.join(', ')}`,
                'text',
                {
                  kind: 'chapter_draft',
                  book_id: bookId,
                  chapter_number: chapterNumber,
                  chapter_title: chapterTitle,
                  word_count: wordCount,
                  key_events: keyEvents,
                  step: 'chapter_drafting',
                  status: 'pending_approval'
                },
                session.user.id
              );
            }
          }

          // Also save to the existing book database using the current book tool
          const { createBook } = await import('./create-book');
          const bookTool = createBook({ session, dataStream });
          
          // Execute the existing book creation to save to database
          if (bookTool.execute) {
            await bookTool.execute({
            bookId,
            bookTitle: `Book ${bookId}`, // We'll need to retrieve this from memory
            chapterTitle,
            chapterNumber,
            description: `Draft chapter with ${wordCount} words`,
            bookContext: chapterText
          }, { toolCallId: 'book-save-' + Date.now(), messages: [] } as ToolCallOptions);
          }

        } catch (error) {
          console.error('[draftChapter] Error saving:', error);
        }
      }

      return {
        success: true,
        bookId,
        chapterNumber,
        chapterTitle,
        wordCount,
        keyEvents,
        nextStep: 'Approval Gate 2: Please review and approve the chapter draft. If approved and this is a picture book, we\'ll proceed to scene segmentation.',
        approvalRequired: true
      };
    },
  });

// Step 3: Scene Segmentation and Environment Mapping Tool
export const segmentChapterIntoScenes = ({ session, dataStream }: { session: Session; dataStream: DataStreamWriter }) =>
  tool({
    description: `Step 3 of Enhanced Book Creation: Break chapter into scenes with environment mapping.
    
    Only used for picture books. Segments chapter text into individual scenes,
    each tied to a specific environment (location + time + weather).`,
    inputSchema: sceneSegmentationSchema,
    execute: async (input) => {
      const { bookId, chapterNumber, scenes } = input;
      
      dataStream.write?.({
        type: 'kind',
        content: 'scene_segmentation',
      });

      dataStream.write?.({
        type: 'title',
        content: `Chapter ${chapterNumber} - Scene Breakdown`,
      });

      dataStream.write?.({
        type: 'id',
        content: `${bookId}_scenes_ch${chapterNumber}`,
      });

      // Save scenes and environments to memory
      if (session?.user?.id) {
        try {
          const { createMemoryService } = await import('@/lib/ai/memory/service');
          const { ensurePaprUser } = await import('@/lib/ai/memory/middleware');
          const apiKey = process.env.PAPR_MEMORY_API_KEY;
          
          if (apiKey) {
            const memoryService = createMemoryService(apiKey);
            const paprUserId = await ensurePaprUser(session.user.id, apiKey);
            
            if (paprUserId) {
              // Save each scene
              for (const scene of scenes) {
                await memoryService.storeContent(
                  paprUserId,
                  `Scene ${scene.sceneNumber}: ${scene.synopsis}\n\nEnvironment: ${scene.environment.location} at ${scene.environment.timeOfDay}\nWeather: ${scene.environment.weather}\nMood: ${scene.environment.mood}\n\nRequired Characters: ${scene.requiredCharacters.join(', ')}\nRequired Props: ${scene.requiredProps.join(', ')}\n\n${scene.continuityNotes || ''}`,
                  'text',
                  {
                    kind: 'scene',
                    book_id: bookId,
                    chapter_number: chapterNumber,
                    scene_id: scene.sceneId,
                    scene_number: scene.sceneNumber,
                    location: scene.environment.location,
                    time_of_day: scene.environment.timeOfDay,
                    weather: scene.environment.weather,
                    required_characters: scene.requiredCharacters,
                    required_props: scene.requiredProps,
                    step: 'scene_segmentation',
                    status: 'pending_approval'
                  },
                  session.user.id
                );

                // Save environment draft
                await memoryService.storeContent(
                  paprUserId,
                  `Environment: ${scene.environment.location}\n\nTime: ${scene.environment.timeOfDay}\nWeather: ${scene.environment.weather}\nMood: ${scene.environment.mood}\nDescription: ${scene.environment.description}`,
                  'text',
                  {
                    kind: 'environment',
                    book_id: bookId,
                    environment_id: `${bookId}_env_${scene.environment.location}_${scene.environment.timeOfDay}`,
                    location: scene.environment.location,
                    time_of_day: scene.environment.timeOfDay,
                    weather: scene.environment.weather,
                    step: 'scene_segmentation',
                    status: 'pending_approval'
                  },
                  session.user.id
                );
              }
            }
          }
        } catch (error) {
          console.error('[segmentChapterIntoScenes] Error saving to memory:', error);
        }
      }

      return {
        success: true,
        bookId,
        chapterNumber,
        scenesCreated: scenes.length,
        scenes: scenes.map(s => ({
          sceneId: s.sceneId,
          synopsis: s.synopsis,
          environment: s.environment.location,
          timeOfDay: s.environment.timeOfDay
        })),
        nextStep: 'Approval Gate 3: Please review and approve the scene list and environment mapping before creating character portraits.',
        approvalRequired: true
      };
    },
  });

// Batch Character Creation Schema
const batchCharacterCreationSchema = z.object({
  bookId: z.string().describe('The book ID'),
  characters: z.array(z.object({
    characterName: z.string().describe('Character name to create portrait for'),
    portraitStyle: z.string().describe('Art style for the portrait (consistent with book style)'),
    baseOutfit: z.string().describe('Description of the character\'s base outfit - their standard, consistent clothing worn throughout the book'),
    props: z.array(z.object({
      propName: z.string(),
      description: z.string(),
      mustPresent: z.boolean().describe('Whether this prop must appear in every scene with this character'),
      size: z.string().describe('Relative size (small, medium, large)'),
      material: z.string().describe('Material/texture of the prop')
    })).optional().describe('Associated character props to create')
  })).max(3).describe('Up to 3 characters to create at once for feedback'),
  generatePortraits: z.boolean().describe('Whether to generate new portraits or use existing'),
  transparentBackground: z.boolean().default(true).describe('Whether to generate with transparent/white background for scene composition')
});

// Step 4: Batch Character Portrait and Props Creation Tool
export const createCharacterPortraits = ({ session, dataStream }: { session: Session; dataStream: DataStreamWriter }) =>
  tool({
    description: `Step 4 of Enhanced Book Creation: Create character portraits and props in batches.
    
    Creates up to 3 character portraits at a time with transparent/white backgrounds 
    and consistent base outfits for scene composition. Searches memory for existing 
    canon character images first. Requires approval before creating more characters.`,
    inputSchema: batchCharacterCreationSchema,
    execute: async (input) => {
      const { bookId, characters, generatePortraits, transparentBackground } = input;
      
      dataStream.write?.({
        type: 'kind',
        content: 'batch_character_portraits',
      });

      dataStream.write?.({
        type: 'title',
        content: `Batch Character Creation (${characters.length} characters)`,
      });

      dataStream.write?.({
        type: 'id',
        content: `${bookId}_batch_characters_${Date.now()}`,
      });

      const results = [];
      
      for (const character of characters) {
        const { characterName, portraitStyle, baseOutfit, props } = character;
        let portraitUrl = '';
        let existingPortrait = false;

        // Search memory for existing character portrait (broader search across all books first)
        if (session?.user?.id) {
          try {
            const { createMemoryService } = await import('@/lib/ai/memory/service');
          const { ensurePaprUser } = await import('@/lib/ai/memory/middleware');
            const apiKey = process.env.PAPR_MEMORY_API_KEY;
            
            if (apiKey) {
              const memoryService = createMemoryService(apiKey);
              const paprUserId = await ensurePaprUser(session.user.id, apiKey);
              
              if (paprUserId) {
                console.log(`[createCharacterPortraits] Searching memory for character: ${characterName}`);
                
                // First: Search for existing character in THIS book
                let existingCharacters = await memoryService.searchMemories(
                  paprUserId, 
                  `character ${characterName} portrait ${bookId}`,
                  10
                );

                let existingCharacter = existingCharacters.find((mem: FormattedMemory) => 
                  mem.metadata?.kind === 'character' && 
                  mem.metadata?.character_name === characterName &&
                  mem.metadata?.book_id === bookId &&
                  mem.metadata?.portrait_url
                );

                // Second: If not found in this book, search across ALL books for this character
                if (!existingCharacter) {
                  console.log(`[createCharacterPortraits] Character ${characterName} not found in current book, searching across all books...`);
                  
                  const globalCharacters = await memoryService.searchMemories(
                    paprUserId, 
                    `character "${characterName}" portrait personality description`,
                    15
                  );

                  existingCharacter = globalCharacters.find((mem: FormattedMemory) => 
                    mem.metadata?.kind === 'character' && 
                    mem.metadata?.character_name === characterName &&
                    mem.metadata?.portrait_url
                  );
                  
                  if (existingCharacter) {
                    console.log(`[createCharacterPortraits] Found existing character ${characterName} from different book: ${existingCharacter.metadata?.book_title || 'Unknown'}`);
                  }
                }

                if (existingCharacter && existingCharacter.metadata?.portrait_url) {
                  portraitUrl = existingCharacter.metadata.portrait_url as string;
                  existingPortrait = true;
                  console.log(`[createCharacterPortraits] Using existing portrait for ${characterName}: ${portraitUrl.substring(0, 50)}...`);
                } else {
                  console.log(`[createCharacterPortraits] No existing portrait found for ${characterName}, will generate new one if requested`);
                }
              }
            }
          } catch (error) {
            console.error('[createCharacterPortraits] Error searching memory:', error);
          }
        }

        // Generate new portrait if needed and requested
        if (!existingPortrait && generatePortraits) {
          try {
            const { createImage } = await import('./create-image');
            const imageTool = createImage({ session });

            // Get character description from memory
            const characterDescription = await getCharacterDescription(session, bookId, characterName);
            
            if (imageTool.execute) {
              const imageResult = await imageTool.execute({
              description: `CHILDREN'S BOOK CHARACTER PORTRAIT: ${characterName} - ${characterDescription}. Art style: ${portraitStyle}. 

CRITICAL REQUIREMENTS:
1. CHARACTER wearing their BASE OUTFIT: ${baseOutfit} (this is their standard, consistent clothing worn throughout the book)
2. PURE WHITE BACKGROUND or TRANSPARENT BACKGROUND for easy scene composition
3. Full body or 3/4 body portrait showing the complete character
4. Character should be CENTERED and take up most of the frame
5. NO background elements, NO scenery, NO environment - just the character
6. Clean, sharp edges suitable for cutout composition into scenes
7. Character should be looking forward or at a slight angle
8. Consistent with children's book illustration style

This portrait will be used as a seed image for scene composition, so it must have a clean white/transparent background and show the character's complete base outfit clearly.`,
              sceneContext: `Character portrait for book illustration with white/transparent background, designed for scene composition and consistency across multiple scenes`,
              styleConsistency: true,
              aspectRatio: '3:4'
            }, { toolCallId: 'book-character-' + Date.now(), messages: [] } as ToolCallOptions) as CreateImageOutput;

              if (imageResult.imageUrl) {
                portraitUrl = imageResult.imageUrl;
              }
            }
          } catch (error) {
            console.error('[createCharacterPortraits] Error generating portrait:', error);
          }
        }

        // Save character with portrait to memory
        if (session?.user?.id && portraitUrl) {
          try {
            const { createMemoryService } = await import('@/lib/ai/memory/service');
          const { ensurePaprUser } = await import('@/lib/ai/memory/middleware');
            const apiKey = process.env.PAPR_MEMORY_API_KEY;
            
            if (apiKey) {
              const memoryService = createMemoryService(apiKey);
              const paprUserId = await ensurePaprUser(session.user.id, apiKey);
              
              if (paprUserId) {
                await memoryService.storeContent(
                  paprUserId,
                  `Character: ${characterName}\nPortrait: ${portraitUrl}\nBase Outfit: ${baseOutfit}\nStyle: ${portraitStyle}\nTransparent Background: ${transparentBackground}`,
                  'document',
                  {
                    kind: 'character',
                    book_id: bookId,
                    character_name: characterName,
                    portrait_url: portraitUrl,
                    portrait_style: portraitStyle,
                    base_outfit: baseOutfit,
                    transparent_background: transparentBackground,
                    step: 'character_creation',
                    status: 'pending_approval'
                  },
                  session.user.id
                );

                // Save props if provided
                if (props && props.length > 0) {
                  for (const prop of props) {
                    await memoryService.storeContent(
                      paprUserId,
                      `Prop: ${prop.propName}\nDescription: ${prop.description}\nMaterial: ${prop.material}\nSize: ${prop.size}\nMust Present: ${prop.mustPresent}`,
                      'text',
                      {
                        kind: 'prop',
                        book_id: bookId,
                        character_name: characterName,
                        prop_name: prop.propName,
                        must_present: prop.mustPresent,
                        size: prop.size,
                        material: prop.material,
                        step: 'character_creation',
                        status: 'pending_approval'
                      },
                      session.user.id
                    );
                  }
                }
              }
            }
          } catch (error) {
            console.error('[createCharacterPortraits] Error saving to memory:', error);
          }
        }

        results.push({
          characterName,
          portraitUrl,
          existingPortrait,
          propsCreated: props?.length || 0
        });
      }

      return {
        success: true,
        bookId,
        charactersProcessed: results.length,
        results,
        nextStep: `Approval Gate 4: Please review and approve the ${results.length} character portraits and props. If approved, you can create more characters (up to 3 at a time) or proceed to environment creation.`,
        approvalRequired: true,
        canCreateMoreCharacters: true,
        maxBatchSize: 3
      };
    },
  });

// Helper function to get character description from memory (searches across all books)
async function getCharacterDescription(session: Session, bookId: string, characterName: string): Promise<string> {
  try {
    const { createMemoryService } = await import('@/lib/ai/memory/service');
    const { ensurePaprUser } = await import('@/lib/ai/memory/middleware');
    const apiKey = process.env.PAPR_MEMORY_API_KEY;
    
    if (!apiKey || !session?.user?.id) return '';
    
    const memoryService = createMemoryService(apiKey);
    const paprUserId = await ensurePaprUser(session.user.id, apiKey);
    
    if (!paprUserId) return '';
    
    console.log(`[getCharacterDescription] Searching for character: ${characterName}`);
    
    // First: Search in current book
    let memories = await memoryService.searchMemories(
      paprUserId,
      `character ${characterName} personality physical description ${bookId}`,
      5
    );

    let characterMemory = memories.find((mem: FormattedMemory) => 
      mem.metadata?.kind === 'character' && 
      mem.metadata?.character_name === characterName &&
      mem.metadata?.book_id === bookId
    );

    // Second: If not found in current book, search globally
    if (!characterMemory) {
      console.log(`[getCharacterDescription] Character ${characterName} not found in current book, searching globally...`);
      
      const globalMemories = await memoryService.searchMemories(
        paprUserId,
        `character "${characterName}" personality physical description`,
        10
      );

      characterMemory = globalMemories.find((mem: FormattedMemory) => 
        mem.metadata?.kind === 'character' && 
        mem.metadata?.character_name === characterName
      );
      
      if (characterMemory) {
        console.log(`[getCharacterDescription] Found character ${characterName} from different book: ${characterMemory.metadata?.book_title || 'Unknown'}`);
      }
    }

    if (characterMemory?.content) {
      console.log(`[getCharacterDescription] Using existing description for ${characterName}`);
      return characterMemory.content;
    } else {
      console.log(`[getCharacterDescription] No existing description found for ${characterName}`);
      return `${characterName} from the book`;
    }
  } catch (error) {
    console.error('[getCharacterDescription] Error:', error);
    return `${characterName} from the book`;
  }
}

export type BookPlanInput = z.infer<typeof bookPlanningSchema>;
export type ChapterDraftInput = z.infer<typeof chapterDraftSchema>;
export type SceneSegmentationInput = z.infer<typeof sceneSegmentationSchema>;
export type BatchCharacterCreationInput = z.infer<typeof batchCharacterCreationSchema>;
export type CharacterPortraitInput = z.infer<typeof characterPortraitSchema>;

// Async database storage function for characters and props
async function saveCharactersToDatabase(
  userId: string, 
  bookId: string, 
  bookTitle: string, 
  characters: any[]
): Promise<void> {
  try {
    console.log('[saveCharactersToDatabase] Saving characters to database...');
    
    // Import database utilities
    const { db } = await import('@/lib/db/db');
    const { sql } = await import('drizzle-orm');
    
    // Check if we have a book_props table or similar
    // For now, we'll store in a generic way that can be expanded
    for (const character of characters) {
      try {
        // Check if character already exists to avoid duplicates
        const existingChar = await db.execute(
          sql`SELECT id FROM book_props 
              WHERE user_id = ${userId} 
              AND book_id = ${bookId} 
              AND prop_type = 'character' 
              AND prop_name = ${character.name}
              LIMIT 1`
        );

        if (existingChar.length === 0) {
          // Insert new character
          await db.execute(
            sql`INSERT INTO book_props (
              user_id, book_id, book_title, prop_type, prop_name, 
              prop_data, created_at, updated_at
            ) VALUES (
              ${userId}, ${bookId}, ${bookTitle}, 'character', ${character.name},
              ${JSON.stringify({
                role: character.role,
                personality: character.personality,
                physicalDescription: character.physicalDescription,
                backstory: character.backstory
              })}, 
              NOW(), NOW()
            )`
          );
          
          console.log(`[saveCharactersToDatabase] ✅ Saved character: ${character.name}`);
        } else {
          console.log(`[saveCharactersToDatabase] Character ${character.name} already exists, skipping`);
        }
      } catch (charError) {
        console.error(`[saveCharactersToDatabase] Error saving character ${character.name}:`, charError);
      }
    }
    
    console.log('[saveCharactersToDatabase] ✅ Completed database storage');
  } catch (error) {
    console.error('[saveCharactersToDatabase] Database storage failed:', error);
    // Don't throw - this is a background operation
  }
}
export type EnvironmentCreationInput = z.infer<typeof environmentCreationSchema>;
export type SceneCompositionInput = z.infer<typeof sceneCompositionSchema>;
