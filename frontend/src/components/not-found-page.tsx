import { Link } from 'react-router'
import { FileSearch2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

export const NotFoundPage = () => {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="flex flex-col items-center gap-4 text-center">
        <FileSearch2 className="h-10 w-10 text-muted-foreground" />
        <div>
          <h1 className="text-h2-600 font-semibold">404 — Not found</h1>
          <p className="mt-1 text-s-400 text-muted-foreground">
            The page you're looking for doesn't exist or has moved.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link to="/">Back to sessions</Link>
        </Button>
      </div>
    </div>
  )
}
