import { useState, useEffect } from 'react';
import { Outlet } from 'react-router';


const slides = [
  {
    id: 1,
    title: 'Your Complete HR Management Platform',
    description:
      'Simplify workforce management with an intelligent HRMS platform. Manage employees, streamline HR operations, automate workflows, and bring your entire organization together in one place.',
    image: '/image1.svg',
  },
  {
    id: 2,
    title: 'Manage Your Workforce Seamlessly',
    description:
      'Centralize employee information, maintain digital employee records, manage departments, assign designations, and simplify the complete employee lifecycle from onboarding to exit.',
    image: '/image2.svg',
  },
  {
    id: 3,
    title: 'Smart Attendance & Leave Management',
    description:
      'Track daily attendance, monitor working hours, manage shifts, apply for leaves, automate approval workflows, and maintain accurate employee attendance records.',
    image: '/image3.png',
  },
  {
    id: 4,
    title: 'Accurate Payroll, Simplified Operations',
    description:
      'Streamline salary processing, manage earnings and deductions, generate payslips, maintain payroll records, and simplify monthly payroll operations with greater accuracy.',
    image: '/image4.svg',
  },
  {
    id: 5,
    title: 'Build Better Teams Through Insights',
    description:
      'Manage recruitment, track employee performance, organize training programs, monitor workforce productivity, and make smarter HR decisions with insightful reports and analytics.',
    image: '/image5.png',
  },
];

/** Split layout matching the PuffinTheme-style login with native carousel */
export function AuthLayout() {
  const [currentIndex, setCurrentIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentIndex((prevIndex) => (prevIndex + 1) % slides.length);
    }, 5000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="relative flex min-h-dvh max-w-full flex-col lg:flex-row">
      {/* Left dark panel containing the Carousel */}
      <div className="relative hidden flex-1 flex-col items-center justify-center bg-stone-100 px-4 py-10 lg:flex">
        <div className="hidden max-w-full text-center lg:block">
          <div className="mx-auto w-full max-w-[1000px] h-full overflow-hidden relative">
            <div
              className="flex transition-transform duration-500 ease-in-out"
              style={{ transform: `translateX(-${currentIndex * 100}%)` }}
            >
              {slides.map((slide) => (
                <div key={slide.id} className="w-full shrink-0 flex flex-col items-center text-center px-4">
                  {/* Image */}
                  <div className="mb-6 mt-6 h-[300px] w-[600px] overflow-hidden">
                    <img
                      src={slide.image}
                      alt={slide.title}
                      className="h-full w-full object-cover transition-transform duration-500 hover:scale-105"
                    />
                  </div>

                  {/* Heading */}
                  <h2 className="text-2xl font-semibold text-gray-800 font-font-4">
                    {slide.title}
                  </h2>

                  {/* Description */}
                  <p className="mt-2 max-w-[600px] text-sm text-gray-500 font-font-4">
                    {slide.description}
                  </p>
                </div>
              ))}
            </div>

            {/* Pagination Indicators */}
            
          </div>
        </div>
      </div>

      {/* Right light panel containing the floating login Outlet */}
      <div className="flex w-full flex-1 items-start justify-center bg-linear-to-b from-white from-[38%] to-blue-800 to-[38%] px-4 pt-24 pb-10 sm:items-center sm:px-6 sm:py-12 lg:block lg:w-[25%] lg:flex-initial lg:bg-none lg:bg-blue-800 lg:p-0">
        <div className="relative z-10 w-full max-w-100 lg:absolute lg:-ml-50 lg:mt-40">
          <div className="p-6 sm:p-8 bg-white border border-white/30 rounded-[6px] sm:rounded-[4px] shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}