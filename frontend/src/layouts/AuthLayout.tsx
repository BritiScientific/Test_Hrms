

import { Outlet } from 'react-router';



/** Split layout matching the PuffinTheme-style login */

export function AuthLayout() {

  return (

    <div className="relative flex min-h-dvh max-w-full">

      {/* Left dark panel */}

      <div className="relative flex flex-1 flex-col items-center justify-center bg-stone-100 px-4 py-10">

       
        <div className=" hidden max-w-full text-center lg:block">

          

        </div>

      </div>

      {/* Right light panel */}

      <div className="hidden w-[25%] bg-blue-800 lg:block" >
         <div className="absolute -ml-50 mt-30 z-10 w-full max-w-100 ">
          <div className='p-8 bg-white border border-white/30 rounded-[8px] shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]'>
            <Outlet />
          </div>
        </div>
      </div>

    </div>

  );

}