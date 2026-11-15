import { signInWithPopup } from 'firebase/auth'
import React from 'react'
import { auth, googleProvider } from '../../utils/firebase'
import api from '../../utils/axios'
import { FcGoogle } from "react-icons/fc";
import { useDispatch, useSelector } from 'react-redux';
import { setUserdata } from '../redux/userSlice';
import SideBar from '../components/SideBar';
import ChatArea from '../components/ChatArea';
import Artifact from '../components/Artifact';

function Home() {
    const {userData}=useSelector(state=>state.user)
    const dispatch=useDispatch()
    const [loginError, setLoginError] = React.useState(null)
    const [isLoggingIn, setIsLoggingIn] = React.useState(false)

    const handleLogin = async (token) => {
        try {
            const { data } = await api.post("/api/auth/login", { token })
            dispatch(setUserdata(data))
            setLoginError(null)
        } catch (error) {
            const message = error.response?.data?.message || error.message || "Unable to complete login."
            console.error("Backend login failed", error)
            setLoginError(message)
            throw error
        }
    }


    const googleLogin = async () => {
        setIsLoggingIn(true)
        setLoginError(null)
        try {
            const data = await signInWithPopup(auth, googleProvider)
            const token = await data.user.getIdToken()
            await handleLogin(token)
        } catch (error) {
            console.error("Google login failed. Check the Firebase web app configuration and authorized domains.", error)
        } finally {
            setIsLoggingIn(false)
        }
    }
    return (
        <div className='h-screen  flex bg-[#0d0f14] text-white overflow-hidden'>

<SideBar/>
<ChatArea/>
<Artifact/>




{!userData &&   <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur'>
                <div className='w-[340px] bg-[#13151c] border border-white/[0.08] rounded-2xl p-7 flex flex-col gap-5'>
                    <div className='flex flex-col gap-1'>
                        <h2 className='text-[17px] font-semibold text-slate-100 tracking-tight'>Welcome to CortexAI</h2>
                        <p className='text-[13px] text-slate-500'>Please login to continue using the app.</p>
                    </div>

                    <button disabled={isLoggingIn} className='w-full flex items-center justify-center gap-3 py-[11px] rounded-xl text-sm font-medium text-black/90 bg-white hover:bg-gray-200 disabled:opacity-60 transition-all duration-150 cursor-pointer' onClick={googleLogin}>
                        <FcGoogle size={15} />
                        {isLoggingIn ? "Signing in..." : "Continue With Google"}
                    </button>
                    {loginError && <p className='text-[12px] text-red-400 break-words'>{loginError}</p>}
                </div>
            </div>}
          
        </div>
    )
}

export default Home
