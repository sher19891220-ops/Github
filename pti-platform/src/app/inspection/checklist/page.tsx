'use client'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function ChecklistPage() {
  const router = useRouter()
  useEffect(() => { router.replace('/inspection/signature') }, [router])
  return null
}
