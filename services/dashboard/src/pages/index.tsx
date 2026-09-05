/**
 * Next.js Dashboard Pages
 * Main UI for content management and monitoring
 */

import React, { useEffect, useState } from 'react';
import { useAuth } from '@viralforge/auth';
import { useQuery } from 'react-query';

const DashboardLayout = ({ children }: { children: React.ReactNode }) => {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8" className="flex justify-between h-16 items-center">
          <div className="flex-shrink-0">
            <a href="/" className="text-xl font-bold text-gray-800">
              ViralForge
            </a>
          </div>
          <div className="hidden md:block">
            <div className="ml-6 flex items-center md:ml-10">
              <div className="inline-block py-2 px-4 rounded-md bg-indigo-600 text-sm font-medium text-white">
                Dashboard
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {children}
      </main>

      <footer className="bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center py-8">
          <p className="text-sm text-gray-600">
            © {new Date().getFullYear()} ViralForge. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  );
};

export default DashboardLayout;

// Calendar Page
export const CalendarPage = () => {
  const { user } = useAuth();
  const { isLoading } = useQuery(['calendar'], async () => {
    // In a real app, this would fetch from API
    return {
      items: [
        {
          id: '1',
          title: 'Mumbai Street Food',
          date: '2026-09-05',
          niche: 'food',
          status: 'scheduled'
        },
        {
          id: '2',
          title: 'Punjabi Thali',
          date: '2026-09-06',
          niche: 'food',
          status: 'draft'
        }
      ]
    };
  });

  if (isLoading) return <div>Loading calendar...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Content Calendar</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {['2026-09-05', '2026-09-06', '2026-09-07'].map((date) => (
          <div key={date} className="p-4 border rounded shadow">
            <h2 className="font-semibold mb-2 text-lg">{date}</h2>
            {isLoading
              ? <p>Loading items...</p>
              : (
                <div className="flex flex-col space-y-2">
                  {['1', '2', '2'].map((time) => (
                    <div key={time} className="flex items-center mb-2">
                      <span className="text-sm text-gray-600 mr-2">{time}hr</span>
                      {isLoading
                        ? <span className="text-gray-400">Loading...</span>
                        : (
                          <span className="text-indigo-600 font-medium">
                            {isLoading
                              ? 'Loading...'
                              : 'Mumbai Street Food'}
                          </span>
                        )
                      </span>
                    </div>
                  ))}
                </div>
              )
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8">
        <button
          className="bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 transition-colors"
          onClick={() => alert('Create New Content')}
        >
          + New Content
        </button>
      </div>
    </div>
  );
};

// Accounts Page
export const AccountsPage = () => {
  const { user } = useAuth();
  const { isLoading } = useQuery(['accounts'], async () => {
    // In a real app, this would fetch from API
    return [
      {
        id: 'instagram-123',
        name: 'Journey Shivam',
        platform: 'instagram',
        accountType: 'professional',
        status: 'active',
        connectedAt: '2026-01-15',
        tokenExpiresAt: '2026-09-15'
      },
      {
        id: 'facebook-456',
        name: 'Journey Shivam FB',
        platform: 'facebook',
        accountType: 'business',
        status: 'active',
        connectedAt: '2026-01-15',
        tokenExpiresAt: '2026-09-15'
      }
    ];
  });

  if (isLoading) return <div>Loading accounts...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Connected Accounts</h1>

      <div className="space-y-4">
        {['instagram-123', 'facebook-456'].map((accountId) => {
          const account = isLoading
            ? {}
            : [
              {
                id: 'instagram-123',
                name: 'Journey Shivam',
                platform: 'instagram',
                accountType: 'professional',
                status: 'active',
                connectedAt: '2026-01-15',
                tokenExpiresAt: '2026-09-15'
              },
              {
                id: 'facebook-456',
                name: 'Journey Shivam FB',
                platform: 'facebook',
                accountType: 'business',
                status: 'active',
                connectedAt: '2026-01-15',
                tokenExpiresAt: '2026-09-15'
              ]
            ].find(a => a.id === accountId);

          return (
            <div key={accountId} className="p-4 border rounded shadow bg-white">
              <div className="flex justify-between items-center">
                <div>
                  <strong className="text-gray-800">{account.name}</strong>
                  <span className="text-sm text-gray-500 mr-2">({account.platform})</span>
                  <span className={`text-${account.status === 'active' ? 'green-600' : 'red-500'}`} className="ml-2">
                    {account.status === 'active' ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="text-sm text-gray-500">
                  Connected: {new Date(account.connectedAt).toLocaleDateString()}
                  <span className="ml-2">| Expires: {new Date(account.tokenExpiresAt).toLocaleDateString()}</span>
                </div>
              </div>
            </div>
        })})}
      </div>
    </div>
  );
};

// Jobs Page
export const JobsPage = () => {
  const { user } = useAuth();
  const { isLoading } = useQuery(['jobs'], async () => {
    // In a real app, this would fetch from API
    return [
      {
        id: 'job-1',
        contentItemId: 'content-1',
        type: 'generation',
        status: 'completed',
        createdAt: '2026-09-01',
        completedAt: '2026-09-01'
      },
      {
        id: 'job-2',
        contentItemId: 'content-2',
        type: 'rendering',
        status: 'failed',
        createdAt: '2026-09-02',
        completedAt: '2026-09-02'
      }
    ];
  });

  if (isLoading) return <div>Loading jobs...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Job Queue</h1>

      <div className="space-y-4">
        {['job-1', 'job-2'].map((jobId) => {
          const job = isLoading
            ? {}
            : [
              {
                id: 'job-1',
                contentItemId: 'content-1',
                type: 'generation',
                status: 'completed',
                createdAt: '2026-09-01',
                completedAt: '2026-09-01'
              },
              {
                id: 'job-2',
                contentItemId: 'content-2',
                type: 'rendering',
                status: 'failed',
                createdAt: '2026-09-02',
                completedAt: '2026-09-02'
              }
            ].find(j => j.id === jobId);

          return (
            <div key={jobId} className="p-4 border rounded shadow">
              <div className="flex justify-between">
                <strong className="text-gray-800">{job.type}</strong>
                <span className={`text-${job.status === 'completed' ? 'green-600' : job.status === 'failed' ? 'red-500' : 'orange-600'}`}>
                  {job.status}
                </span>
              </div>
              <div className="text-sm text-gray-600 mt-1">
                Content: {job.contentItemId} • Created: {new Date(job.createdAt).toLocaleDateString()}
              </div>
            </div>
          );
        })})}
      </div>
    </div>
  );
};

// Analytics Page
export const AnalyticsPage = () => {
  const { user } = useAuth();
  const { isLoading } = useQuery(['analytics'], async () => {
    // In a real app, this would fetch from API
    return {
      totalPosts: 15,
      publishedPosts: 8,
      failedPosts: 2,
      topNiche: 'food',
      avgEngagement: 1250,
      growthRate: '15% MoM'
    };
  });

  if (isLoading) return <div>Loading analytics...</div>;

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-6">Analytics Dashboard</h1>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded shadow">
          <h2 className="text-lg font-semibold mb-2">Overview</h2>
          <div className="flex justify-between">
            <div>Total Posts</div>
            <div className="text-indigo-600 text-xl">{isLoading ? 'Loading...' : '15'}</div>
          </div>
        </div>

        <div className="bg-white p-6 rounded shadow">
          <h2 className="text-lg font-semibold mb-2">Performance</h2>
          <div className="flex justify-between">
            <div>Published Posts</div>
            <div className="text-indigo-600 text-xl">{isLoading ? 'Loading...' : '8'}</div>
          </div>
        </div>

        <div className="bg-white p-6 rounded shadow">
          <h2 className="text-lg font-semibold mb-2">Top Niche</h2>
          <div className="text-xl font-bold text-indigo-600">{isLoading ? 'Loading...' : 'food'}</div>
        </div>

        <div className="bg-white p-6 rounded shadow">
          <h2 className="text-lg font-semibold mb-2">Engagement</h2>
          <div className="text-xl font-bold text-gray-800">{isLoading ? 'Loading...' : '1250'}</div>
        </div>
      </div>
    </div>
  );
};

// Landing Page
export const LandingPage = () => {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center text-center">
      <h1 className="text-4xl font-bold mb-6 text-indigo-600">
        ViralForge
      </h1>
      <p className="text-lg text-gray-700 mb-8">
        Hindi Regional Food Content Automation Platform
      </p>
      <div className="flex justify-center">
        <a
          href="/dashboard"
          className="bg-indigo-600 text-white px-8 py-4 rounded-md hover:bg-indigo-700 transition-colors"
        >
          Go to Dashboard
        </a>
      </div>
    </div>
  );
};

export default {
  DashboardLayout,
  CalendarPage,
  AccountsPage,
  JobsPage,
  AnalyticsPage,
  LandingPage,
};