import { tool } from 'ai';
import { z } from 'zod';
import type { Session } from 'next-auth';
import { generateUUID } from '@/lib/utils';
import type { DataStreamWriter } from '@/lib/types';
import { streamText } from 'ai';
import { openai } from '@ai-sdk/openai';
import { db } from '@/lib/db/db';
import { sql } from 'drizzle-orm';
import { storeContentInMemory } from '@/lib/ai/memory/middleware';

interface CreateBookProps {
  session: Session;
  dataStream: DataStreamWriter;
}

const createBookSchema = z.object({
  bookTitle: z.string().describe('The main title of the book'),
  chapterTitle: z.string().describe('The title of the specific chapter to create or add'),
  chapterNumber: z.number().describe('The chapter number (1, 2, 3, etc.)'),
  description: z.string().optional().describe('Optional description or outline for the chapter'),
  bookId: z.string().optional().describe('Optional bookId for existing book. Use searchBooks tool first (without bookTitle parameter) to get all books and let AI choose the right one. If not provided, a new book will be created.'),
  bookContext: z.string().optional().describe('Optional context about the book, characters, plot, and writing style from previous chapters. Use searchMemories tool first to gather relevant context before calling this tool.'),
});

type CreateBookInput = z.infer<typeof createBookSchema>;
type CreateBookOutput = {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterTitle: string;
  chapterNumber: number;
  content: string;
  saveError?: string;
  saved?: boolean;
};

export const createBook = ({ session, dataStream }: CreateBookProps) =>
  tool({
    description:
      'Create or add to a book with chapters. This tool manages the entire book structure and can add new chapters to existing books. Use this instead of createDocument for book content. IMPORTANT WORKFLOW: 1) Use searchBooks tool first (without bookTitle parameter) to get all existing books and let AI choose the right one, 2) Use searchMemories tool to gather relevant context about the book, characters, plot, and writing style, 3) Pass the relevant context via the bookContext parameter to maintain consistency across chapters.',
    inputSchema: createBookSchema,
    execute: async (input: CreateBookInput): Promise<CreateBookOutput> => {
      const { bookTitle, chapterTitle, chapterNumber, description, bookId: existingBookId, bookContext } = input;
      const id = generateUUID();

      dataStream.write?.({
        type: 'kind',
        content: 'book',
      });

      dataStream.write?.({
        type: 'title',
        content: `${bookTitle} - ${chapterTitle}`,
      });

      dataStream.write?.({
        type: 'id',
        content: id,
      });

      // Use provided book context from the main LLM's memory search
      if (bookContext) {
        console.log(`[createBook] Using provided book context for "${bookTitle}" (${bookContext.length} chars)`);
      } else {
        console.log(`[createBook] No book context provided for "${bookTitle}"`);
      }

      // Generate chapter content
      let draftContent = '';
      
      const contentGenerationPrompt = `You are an expert children's book author. Create engaging, age-appropriate content for young readers. Focus on storytelling, character development, and adventure themes that children will love.

IMPORTANT: You are generating the actual chapter content - write the story content directly. Do not include any tool calls, instructions, or meta-commentary.

${bookContext ? `\n\nBOOK CONTEXT FROM PREVIOUS WORK:\n${bookContext}\n\nUse this context to maintain consistency with characters, plot, and writing style.` : ''}`;

      const chapterPrompt = description 
        ? `Create Chapter ${chapterNumber}: "${chapterTitle}" for the book "${bookTitle}".

Chapter Description/Outline: ${description}

${bookContext ? 'Based on the book context provided above, maintain consistency with established characters, plot, and style.' : ''}

Write a complete, engaging chapter suitable for young readers (ages 4-8). Include:
- Vivid descriptions that spark imagination  
- Age-appropriate dialogue
- Adventure and discovery themes
- Positive character interactions
- A satisfying chapter conclusion

Write the actual story content for this chapter.`
        : `Create Chapter ${chapterNumber}: "${chapterTitle}" for the book "${bookTitle}".

${bookContext ? 'Based on the book context provided above, maintain consistency with established characters, plot, and style.' : ''}

Write a complete, engaging chapter suitable for young readers (ages 4-8). Include:
- Vivid descriptions that spark imagination
- Age-appropriate dialogue  
- Adventure and discovery themes
- Positive character interactions
- A satisfying chapter conclusion

Write the actual story content for this chapter.`;

      const streamResult = streamText({
        model: openai('gpt-4o'),
        system: contentGenerationPrompt,
        prompt: chapterPrompt,
      });

      for await (const textDelta of streamResult.textStream) {
        draftContent += textDelta;
        dataStream.write?.({
          type: 'text-delta',
          content: textDelta,
        });
      }

      // Save the book chapter to database directly
      let savedChapter = null;
      let saveError = null;
      
      if (session?.user?.id) {
        try {
          console.log(`🔥 [createBook] SAVING CHAPTER ${chapterNumber} of "${bookTitle}" 🔥`);
          
          // Use provided bookId or find/create one
          let bookId: string;
          
          if (existingBookId) {
            // Use the provided bookId (from searchBooks tool)
            bookId = existingBookId;
            console.log(`[createBook] Using provided bookId: ${bookId}`);
          } else {
            // Check if a book with this title already exists for this user
            const existingBook = await db.execute(
              sql`SELECT DISTINCT "bookId" FROM "Books" 
                  WHERE "bookTitle" = ${bookTitle} 
                  AND "userId" = ${session.user.id} 
                  LIMIT 1`
            );

            // Generate or use existing bookId
            bookId = existingBook.length > 0 ? String(existingBook[0].bookId) : generateUUID();
            console.log(`[createBook] ${existingBook.length > 0 ? 'Found existing' : 'Generated new'} bookId: ${bookId}`);
          }

          // Check if this specific chapter already exists (latest version)
          console.log(`🔥 [createBook] CHECKING FOR EXISTING CHAPTER ${chapterNumber} 🔥`);
          const existingChapter = await db.execute(
            sql`SELECT * FROM "Books" 
                WHERE "bookId" = ${bookId}
                AND "chapterNumber" = ${chapterNumber} 
                AND "userId" = ${session.user.id} 
                AND "is_latest" = true
                ORDER BY "createdAt" DESC
                LIMIT 1`
          );
          console.log(`[createBook] Found ${existingChapter.length} existing chapters for chapter ${chapterNumber}`);

          if (existingChapter.length > 0) {
            // Create new version of existing chapter
            const existingId = existingChapter[0].id;
            const currentVersion = parseInt(String(existingChapter[0].version || '1'));
            const nextVersion = (currentVersion + 1).toString();
            const newTimestamp = new Date().toISOString();

            // Mark existing version as not latest
            await db.execute(
              sql`UPDATE "Books" 
                  SET "is_latest" = false 
                  WHERE "id" = ${existingId} 
                  AND "is_latest" = true`
            );

            // Insert new version
            const newChapterId = generateUUID();
            const updatedChapter = await db.execute(
              sql`INSERT INTO "Books" ("id", "bookId", "bookTitle", "chapterNumber", "chapterTitle", "content", "userId", "createdAt", "updatedAt", "is_latest", "version") 
                  VALUES (${newChapterId}, ${bookId}, ${bookTitle}, ${chapterNumber}, ${chapterTitle}, ${draftContent}, ${session.user.id}, ${newTimestamp}, ${newTimestamp}, true, ${nextVersion}) 
                  RETURNING *`
            );

            savedChapter = updatedChapter[0];
            console.log(`[createBook] Created new version of chapter:`, savedChapter);
          } else {
            // Create new chapter
            const newChapterId = generateUUID();
            const newChapter = await db.execute(
              sql`INSERT INTO "Books" ("id", "bookId", "bookTitle", "chapterNumber", "chapterTitle", "content", "userId", "createdAt", "updatedAt", "is_latest", "version") 
                  VALUES (${newChapterId}, ${bookId}, ${bookTitle}, ${chapterNumber}, ${chapterTitle}, ${draftContent}, ${session.user.id}, now(), now(), true, '1') 
                  RETURNING *`
            );

            savedChapter = newChapter[0];
            console.log(`[createBook] Created new chapter:`, savedChapter);
          }

          // Async: Save chapter to memory after successful database save
          if (savedChapter && session?.user?.id) {
            console.log(`[createBook] Triggering async memory save for chapter ${chapterNumber} of "${bookTitle}"`);
            saveChapterToMemoryAsync(
              session.user.id,
              bookTitle,
              chapterTitle,
              chapterNumber,
              draftContent,
              bookId
            );

            // Also save book metadata to memory if this is the first chapter
            if (chapterNumber === 1) {
              saveBookMetadataToMemoryAsync(
                session.user.id,
                bookTitle,
                bookId
              );
            }
          }
        } catch (error) {
          saveError = `Error saving book chapter: ${error instanceof Error ? error.message : String(error)}`;
          console.error('[createBook]', saveError);
        }
      } else {
        saveError = 'No user session available for saving';
        console.error('[createBook]', saveError);
      }

      // If save failed, include error in response
      const result = {
        id,
        bookId: savedChapter?.bookId ? String(savedChapter.bookId) : (existingBookId || id), // Use bookId from response or fallback to existing/id
        bookTitle,
        chapterTitle,
        chapterNumber,
        content: draftContent,
        ...(saveError && { saveError }), // Include error if save failed
        ...(savedChapter && { saved: true }), // Indicate successful save
      };

      return result;
    },
  });

/**
 * Asynchronously save a book chapter to memory
 * This runs in the background and doesn't block the main response
 */
async function saveChapterToMemoryAsync(
  userId: string,
  bookTitle: string,
  chapterTitle: string,
  chapterNumber: number,
  content: string,
  bookId: string
): Promise<void> {
  // Run async without blocking
  setImmediate(async () => {
    try {
      const apiKey = process.env.PAPR_MEMORY_API_KEY;
      if (!apiKey) {
        console.log('[createBook] No Papr API key available for memory saving');
        return;
      }

      console.log(`[createBook] Saving chapter ${chapterNumber} of "${bookTitle}" to memory...`);

      // Create memory content with context
      const memoryContent = `Book Chapter: "${bookTitle}" - Chapter ${chapterNumber}: "${chapterTitle}"

${content}

---
Book: ${bookTitle}
Chapter: ${chapterNumber}
Title: ${chapterTitle}
Length: ${content.length} characters`;

      // Create metadata for better organization and retrieval
      // Note: storeContentInMemory will handle user_id mapping automatically
      const metadata = {
        sourceType: 'PaprChat_Book',
        sourceUrl: `/chat/book/${bookId}`,
        external_user_id: userId, // App user ID for external reference
        'emoji tags': ['📚', '✍️', '📖'],
        topics: ['book writing', 'creative writing', bookTitle.toLowerCase().replace(/\s+/g, '_')],
        hierarchical_structures: `knowledge/books/${bookTitle.toLowerCase().replace(/\s+/g, '_')}/chapter_${chapterNumber}`,
        createdAt: new Date().toISOString(),
        customMetadata: {
          category: 'knowledge',
          book_title: bookTitle,
          chapter_title: chapterTitle,
          chapter_number: chapterNumber,
          book_id: bookId,
          content_type: 'book_chapter',
          app_user_id: userId,
          tool: 'createBook'
        }
      };

      // Store in memory
      const success = await storeContentInMemory({
        userId,
        content: memoryContent,
        type: 'document',
        metadata,
        apiKey
      });

      if (success) {
        console.log(`[createBook] ✅ Successfully saved chapter ${chapterNumber} of "${bookTitle}" to memory`);
      } else {
        console.log(`[createBook] ❌ Failed to save chapter ${chapterNumber} of "${bookTitle}" to memory`);
      }
    } catch (error) {
      console.error('[createBook] Error saving chapter to memory:', error);
    }
  });
}

/**
 * Asynchronously save book metadata to memory when a new book is started
 * This helps the AI remember the user's book projects and writing style
 */
async function saveBookMetadataToMemoryAsync(
  userId: string,
  bookTitle: string,
  bookId: string
): Promise<void> {
  // Run async without blocking
  setImmediate(async () => {
    try {
      const apiKey = process.env.PAPR_MEMORY_API_KEY;
      if (!apiKey) {
        console.log('[createBook] No Papr API key available for book metadata memory saving');
        return;
      }

      console.log(`[createBook] Saving book metadata for "${bookTitle}" to memory...`);

      // Create memory content for book project tracking
      const memoryContent = `Book Project Started: "${bookTitle}"

The user has started writing a new book titled "${bookTitle}". This represents their creative writing project and should be remembered for future reference and assistance.

Book ID: ${bookId}
Started: ${new Date().toLocaleDateString()}
Genre: Children's book (based on writing style and content patterns)
Status: Active writing project`;

      // Create metadata for book project tracking
      // Note: storeContentInMemory will handle user_id mapping automatically
      const metadata = {
        sourceType: 'PaprChat_BookProject',
        sourceUrl: `/chat/book/${bookId}`,
        external_user_id: userId, // App user ID for external reference
        'emoji tags': ['📚', '🎯', '✍️', '💡'],
        topics: ['book writing', 'creative projects', 'goals', bookTitle.toLowerCase().replace(/\s+/g, '_')],
        hierarchical_structures: `goals/creative_projects/books/${bookTitle.toLowerCase().replace(/\s+/g, '_')}`,
        createdAt: new Date().toISOString(),
        customMetadata: {
          category: 'goals',
          book_title: bookTitle,
          book_id: bookId,
          content_type: 'book_project',
          project_status: 'active',
          app_user_id: userId,
          tool: 'createBook'
        }
      };

      // Store in memory
      const success = await storeContentInMemory({
        userId,
        content: memoryContent,
        type: 'text',
        metadata,
        apiKey
      });

      if (success) {
        console.log(`[createBook] ✅ Successfully saved book project "${bookTitle}" to memory`);
      } else {
        console.log(`[createBook] ❌ Failed to save book project "${bookTitle}" to memory`);
      }
    } catch (error) {
      console.error('[createBook] Error saving book metadata to memory:', error);
    }
  });
}
